from __future__ import annotations

import base64
import hashlib
from urllib.parse import quote


def _credential_forms(credential: str) -> set[str]:
    utf8 = credential.encode("utf-8", errors="surrogatepass")
    utf32 = credential.encode("utf-32le", errors="surrogatepass")
    forms = {
        credential,
        utf8.hex(),
        base64.b64encode(utf8).decode("ascii"),
        base64.urlsafe_b64encode(utf8).decode("ascii"),
        quote(credential, safe="", errors="surrogatepass"),
        hashlib.sha256(utf8).hexdigest(),
        base64.b64encode(hashlib.sha256(utf8).digest()).decode("ascii"),
        hashlib.sha256(utf32).hexdigest(),
        base64.b64encode(hashlib.sha256(utf32).digest()).decode("ascii"),
    }
    if len(credential) >= 12:
        forms.update((credential[:12], credential[-12:]))
    return {form for form in forms if form}


def assert_no_credential_material(credential: str, *values: object) -> None:
    rendered = "\n".join(str(value) for value in values)
    if any(form in rendered for form in _credential_forms(credential)):
        raise AssertionError("credential material detected in observable output")


__all__ = ["assert_no_credential_material"]
