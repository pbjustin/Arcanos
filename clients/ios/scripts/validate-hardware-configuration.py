#!/usr/bin/env python3
"""Read-only static/build-artifact gate; never launches apps or makes network calls.

The bounded OpenStep parser and Swift conditional selector intentionally fail on
unsupported syntax. This is not an Xcode build, linker, entitlement, or runtime proof.
"""
import argparse
import json
import plistlib
import re
from pathlib import Path
import xml.etree.ElementTree as ET

FLAG = "ARCANOS_HARDWARE_VALIDATION"
HARDWARE_FILES = {"HardwareValidationRuntime.swift", "HardwareValidationView.swift", "HardwareFixtureTransport.swift", "SimulatorRecoveryDriver.swift"}
BUNDLE = "org.arcanos.voice.hardware-validation"
MARKERS = (b"arcanos-hardware-fixture.invalid", b"org.arcanos.voice.hardware-validation.credentials.v1")
UNSAFE = ("NSAllowsArbitraryLoads", "NSExceptionAllowsInsecureHTTPLoads", "NSAllowsLocalNetworking",
          "NSAllowsArbitraryLoadsInWebContent", "NSAllowsArbitraryLoadsForMedia", "NSExceptionDomains",
          "URLCredential(trust:", "serverTrust", "SecTrustSetAnchorCertificates")


def require(condition, message):
    if not condition:
        raise ValueError(message)


def parse_project(source):
    """Parse actual nested pbx objects/configuration references, ignoring comments."""
    tokens = re.findall(r'/\*.*?\*/|//[^\n]*|"(?:\\.|[^"\\])*"|[{}()=;,]|[^\s{}()=;,]+', source, re.S)
    tokens = [t for t in tokens if not t.startswith(("/*", "//"))]
    index = 0

    def take(expected=None):
        nonlocal index
        require(index < len(tokens), "Truncated project")
        value = tokens[index]
        index += 1
        require(expected is None or value == expected, "Unexpected project syntax")
        return value

    def value():
        token = take()
        if token == "{":
            result = {}
            while tokens[index] != "}":
                key = take()
                if key.startswith('"'):
                    key = json.loads(key)
                require(key not in result, "Duplicate project key")
                take("=")
                result[key] = value()
                take(";")
            take("}")
            return result
        if token == "(":
            result = []
            while tokens[index] != ")":
                result.append(value())
                if tokens[index] != ")":
                    take(",")
            take(")")
            return result
        return json.loads(token) if token.startswith('"') else token

    result = value()
    require(index == len(tokens), "Trailing project syntax")
    return result


def selected_swift(source, flags, simulator=False):
    """Resolve nested #if/#elseif/#else before inspecting active source branches."""
    def expression(text):
        text = text.replace("targetEnvironment(simulator)", "true" if simulator else "false").replace("os(iOS)", "true")
        text = re.sub(r"canImport\((\w+)\)", lambda m: "true" if m[1] in {
            "Security", "CryptoKit", "FoundationModels", "Darwin", "OSLog"} else "false", text)
        tokens = re.findall(r"\w+|&&|\|\||[!()]", text)
        require("".join(tokens) == re.sub(r"\s+", "", text), "Unsupported Swift condition")
        index = 0

        def primary():
            nonlocal index
            require(index < len(tokens), "Truncated Swift condition")
            token = tokens[index]
            index += 1
            if token == "!":
                return not primary()
            if token == "(":
                result = disjunction()
                require(index < len(tokens) and tokens[index] == ")", "Unbalanced Swift condition")
                index += 1
                return result
            require(token in {"DEBUG", FLAG, "true", "false"}, "Unknown Swift compilation condition")
            return token == "true" or token in flags

        def conjunction():
            nonlocal index
            result = primary()
            while index < len(tokens) and tokens[index] == "&&":
                index += 1
                right = primary()
                result = result and right
            return result

        def disjunction():
            nonlocal index
            result = conjunction()
            while index < len(tokens) and tokens[index] == "||":
                index += 1
                right = conjunction()
                result = result or right
            return result

        result = disjunction()
        require(index == len(tokens), "Unsupported Swift condition suffix")
        return result

    active, stack, output = True, [], []
    for line in source.splitlines():
        match = re.match(r"\s*#(if|elseif|else|endif)\b\s*(.*)", line)
        if not match:
            if active:
                output.append(line)
            continue
        kind, condition = match.groups()
        if kind == "if":
            matched = expression(condition)
            stack.append([active, matched])
            active = active and matched
        else:
            require(stack, "Unmatched Swift directive")
            parent, matched = stack[-1]
            if kind == "endif":
                active = parent
                stack.pop()
            elif kind == "else":
                active = parent and not matched
                stack[-1][1] = True
            else:
                current = expression(condition)
                active = parent and not matched and current
                stack[-1][1] = matched or current
    require(not stack, "Unterminated Swift directive")
    return "\n".join(output)


def without_comments(source):
    return re.sub(r'"(?:\\.|[^"\\])*"|/\*.*?\*/|//[^\n]*',
                  lambda m: m[0] if m[0].startswith('"') else "", source, flags=re.S)


def validate_sources(ios):
    project_dir = ios / "ArcanosVoice/ArcanosVoice.xcodeproj"
    project = parse_project((project_dir / "project.pbxproj").read_text(encoding="utf-8"))
    objects = project["objects"]
    root = objects[project["rootObject"]]
    targets = [objects[key] for key in root["targets"]]
    require(len(targets) == 1 and targets[0]["name"] == "ArcanosVoice", "Hardware must use the single shipping target")
    target = targets[0]
    target_id = root["targets"][0]
    require(target["productType"] == "com.apple.product-type.application", "Unexpected app target")
    configs = {}
    for owner in (root, target):
        config_list = objects[owner["buildConfigurationList"]]
        require(config_list["defaultConfigurationName"] == "Release", "Default configuration must remain Release")
        entries = [objects[key] for key in config_list["buildConfigurations"]]
        require({x["name"] for x in entries} == {"Debug", "Release", "HardwareValidation"}, "Unexpected configurations")
        for entry in entries:
            require("baseConfigurationReference" not in entry, "External xcconfig needs explicit validation")
            require(not any(key.startswith(("SWIFT_ACTIVE_COMPILATION_CONDITIONS[", "EXCLUDED_SOURCE_FILE_NAMES["))
                            for key in entry["buildSettings"]), "Conditional compilation/exclusion override needs explicit validation")
            configs.setdefault(entry["name"], {}).update(entry["buildSettings"])
    for name, settings in configs.items():
        require(settings["IPHONEOS_DEPLOYMENT_TARGET"] == "18.0", "Minimum deployment target changed")
        flags = set(settings.get("SWIFT_ACTIVE_COMPILATION_CONDITIONS", "").split())
        excluded = set(settings.get("EXCLUDED_SOURCE_FILE_NAMES", "").split())
        hardware = name == "HardwareValidation"
        require((FLAG in flags) == hardware, "Hardware macro leaked or missing")
        require(FLAG not in str(settings.get("OTHER_SWIFT_FLAGS", "")), "Hardware flag supplied outside reviewed compilation conditions")
        require(not settings.get("CODE_SIGN_ENTITLEMENTS"), "New entitlement file requires separate review")
        require(settings["PRODUCT_BUNDLE_IDENTIFIER"] == (BUNDLE if hardware else "org.arcanos.voice"), "Bundle isolation changed")
        require((not HARDWARE_FILES.intersection(excluded)) if hardware else HARDWARE_FILES <= excluded,
                "Hardware source exclusion changed")
        require(("ValidationAssets.xcassets" not in excluded) if hardware else "ValidationAssets.xcassets" in excluded,
                "Validation icon must be exclusive to HardwareValidation")
        require((settings.get("ASSETCATALOG_COMPILER_APPICON_NAME") == "ValidationAppIcon") if hardware
                else not settings.get("ASSETCATALOG_COMPILER_APPICON_NAME"), "Validation app icon selection changed")
        require(not any(any(term in str(k) or term in str(v) for term in UNSAFE) for k, v in settings.items()), "Unsafe network setting")
    phases = [objects[key] for key in target["buildPhases"]]
    require(not any(x["isa"] == "PBXShellScriptBuildPhase" for x in phases), "Unexpected build script phase")
    source_paths = [objects[objects[key]["fileRef"]]["path"] for phase in phases
                    if phase["isa"] == "PBXSourcesBuildPhase" for key in phase["files"]]
    require(HARDWARE_FILES <= {Path(path).name for path in source_paths}, "Hardware source missing from actual target")
    require({path for path in source_paths if Path(path).name in HARDWARE_FILES} == {
        "HardwareValidationRuntime.swift", "HardwareValidationView.swift", "SimulatorRecoveryDriver.swift",
        "../ArcanosKit/Sources/ArcanosHardwareValidation/HardwareFixtureTransport.swift"}, "Hardware source reference moved outside reviewed paths")
    resources = [objects[objects[key]["fileRef"]]["path"] for phase in phases
                 if phase["isa"] == "PBXResourcesBuildPhase" for key in phase["files"]]
    require("PrivacyInfo.xcprivacy" in resources, "Privacy manifest not packaged")
    require("ValidationAssets.xcassets" in resources, "Validation icon catalog missing from target")
    require([objects[key]["productName"] for key in target["packageProductDependencies"]] == ["ArcanosKit"], "App package dependency changed")
    for scheme_name, launch in (("ArcanosVoice", "Debug"), ("ArcanosVoice-HardwareValidation", "HardwareValidation")):
        scheme = ET.parse(project_dir / f"xcshareddata/xcschemes/{scheme_name}.xcscheme").getroot()
        require(all(ref.get("BlueprintIdentifier") == target_id for ref in scheme.iter("BuildableReference")), "Scheme uses another target")
        require(scheme.find("LaunchAction").get("buildConfiguration") == launch, "Scheme launch configuration changed")
        if launch == "Debug":
            require(scheme.find("ArchiveAction").get("buildConfiguration") == "Release", "Shipping archive configuration changed")
        else:
            require(all(entry.get("buildForArchiving") == "YES" for entry in scheme.iter("BuildActionEntry")),
                    "Hardware scheme must support the protected archive path")
            require(scheme.find("ArchiveAction").get("buildConfiguration") == "HardwareValidation",
                    "Hardware archive selected another configuration")
    source_root = ios / "ArcanosVoice/Sources"
    runtime = (source_root / "AppRuntime.swift").read_text(encoding="utf-8")
    hardware_runtime = (source_root / "HardwareValidationRuntime.swift").read_text(encoding="utf-8")
    for name in configs:
        flags = {"DEBUG", FLAG} if name == "HardwareValidation" else ({"DEBUG"} if name == "Debug" else set())
        selected = without_comments(selected_swift(runtime, flags))
        if name == "HardwareValidation":
            require("validation.makeComposition()" in selected and "HardwareFixtureConfiguration.origin" in selected, "Hardware composition not selected")
            require(not re.search(r"(?:restoreGateway|makeShippingComposition|installGateway|DevicePairingClient|URLSessionGatewayTransport)\s*\(", selected),
                    "Hardware runtime can construct a live path")
            require('KeychainCredentialStore(service: HardwareValidationRuntime.keychainService)' in selected, "Keychain service not isolated")
        else:
            require("HardwareValidationRuntime" not in selected and "HardwareFixtureConfiguration" not in selected, "Hardware source selected in shipping configuration")
            require("restoreGateway()" in selected, "Shipping composition removed")
    active_hardware = without_comments(selected_swift(hardware_runtime, {"DEBUG", FLAG}))
    require(BUNDLE in active_hardware and '"ArcanosHardwareValidation-v1"' in active_hardware
            and MARKERS[1].decode() in active_hardware, "Hardware bundle/storage guard missing")
    require("ShippingSessionComposition(" in active_hardware and "transport: transport" in active_hardware, "Shipping orchestration not injected")
    require(not without_comments(selected_swift(hardware_runtime, {"DEBUG"})).strip(), "Hardware runtime active without explicit flag")
    support = (ios / "ArcanosKit/Sources/ArcanosHardwareValidation/HardwareFixtureTransport.swift").read_text(encoding="utf-8")
    require(not re.search(r"\b(?:URLSession|URLSessionGatewayTransport|NWConnection|socket|connect)\s*[.(]", without_comments(support)), "Fixture transport can open a connection")
    driver = (source_root / "SimulatorRecoveryDriver.swift").read_text(encoding="utf-8")
    for flags, simulator in ((set(), True), ({"DEBUG"}, True), ({FLAG, "DEBUG"}, False)):
        require(not without_comments(selected_swift(driver, flags, simulator=simulator)).strip(),
                "Simulator automation leaked into ordinary or physical build")
    require(without_comments(selected_swift(driver, {FLAG, "DEBUG"}, simulator=True)).strip(),
            "Simulator driver missing from validation Simulator build")
    require(not re.search(r"\b(?:URLSession|URLSessionGatewayTransport|NWConnection|socket|connect)\s*[.(]", without_comments(driver)),
            "Simulator driver can open a network connection")
    for path in list(source_root.glob("*.swift")) + list((ios / "ArcanosKit/Sources/ArcanosKit").rglob("*.swift")):
        require(not any(term in without_comments(path.read_text(encoding="utf-8")) for term in UNSAFE), "Unsafe TLS or ATS adapter")
    manifest = without_comments((ios / "ArcanosKit/Package.swift").read_text(encoding="utf-8"))
    require(re.search(r'\.target\(\s*name:\s*"ArcanosKit"\s*\)', manifest), "Shipping ArcanosKit gained dependencies or target options")
    require(re.search(r'\.library\(\s*name:\s*"ArcanosKit",\s*targets:\s*\["ArcanosKit"\]\s*\)', manifest), "Shipping product exports fixture target")
    return {"source_configuration": "PASS", "scope": "Parsed project/schemes and selected source branches; not an Apple build or runtime result"}


def validate_app(app, configuration):
    info = plistlib.loads((app / "Info.plist").read_bytes())
    hardware = configuration == "HardwareValidation"
    require(info.get("CFBundleIdentifier") == (BUNDLE if hardware else "org.arcanos.voice"), "Built bundle identifier mismatch")
    require(info.get("MinimumOSVersion") == "18.0", "Built deployment target mismatch")
    if hardware:
        revision = info.get("ArcanosValidationRevision", "")
        require(re.fullmatch(r"[0-9a-f]{40}", revision), "Built revision must be an explicit full commit SHA")
        require(info.get("CFBundleDisplayName") == "ARCANOS Fixtures", "Hardware display name missing")
        require(info.get("CFBundleIcons", {}).get("CFBundlePrimaryIcon", {}).get("CFBundleIconName") == "ValidationAppIcon",
                "Hardware app icon not compiled")
    require(not any(term in repr(info.get("NSAppTransportSecurity", {})) for term in UNSAFE), "Built ATS exception present")
    plistlib.loads((app / "PrivacyInfo.xcprivacy").read_bytes())
    name = info.get("CFBundleExecutable", "")
    require(name and Path(name).name == name, "Invalid executable path")
    executable = app / name
    require(executable.is_file(), "Built executable missing")
    binaries = [executable] + list(app.rglob("*.dylib"))
    binaries += [folder / folder.stem for folder in app.rglob("*.framework") if (folder / folder.stem).is_file()]
    data = b"".join(path.read_bytes() for path in binaries)
    require(executable.read_bytes()[:4] in (b"\xcf\xfa\xed\xfe", b"\xce\xfa\xed\xfe", b"\xfe\xed\xfa\xcf", b"\xca\xfe\xba\xbe", b"\xbe\xba\xfe\xca"), "Executable is not Mach-O")
    require(all(marker in data for marker in MARKERS) if hardware else all(marker not in data for marker in MARKERS), "Built hardware marker inclusion/exclusion failed")
    return {"built_artifact": "PASS", "configuration": configuration,
            "scope": "Info/privacy and binary marker inspection only; signing, entitlements, compilation provenance and runtime remain separate"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ios-root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--built-app", type=Path)
    parser.add_argument("--configuration", choices=("Debug", "Release", "HardwareValidation"))
    args = parser.parse_args()
    try:
        require(bool(args.built_app) == bool(args.configuration), "Use --built-app and --configuration together")
        result = validate_sources(args.ios_root)
        result["apple_build_runtime"] = "NOT RUN"
        result["built_artifact"] = validate_app(args.built_app, args.configuration) if args.built_app else "NOT RUN"
        print(json.dumps(result, indent=2))
    except (ValueError, KeyError, IndexError, OSError, ET.ParseError, plistlib.InvalidFileException) as error:
        print(json.dumps({"status": "FAIL", "reason": str(error)}))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
