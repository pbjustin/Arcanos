export interface TutorArtifactDigest {
  readonly sha256: string;
  readonly sizeBytes: number;
}

export function digest(value: string | Uint8Array): string;
export function packageFingerprint(files: Iterable<readonly [string, TutorArtifactDigest]>): string;
export function assertArtifactDigest(actual: TutorArtifactDigest, artifact: TutorArtifactDigest): void;
export function tutorAppMapping(mapping: unknown, appId: string, allowMigratedAlias?: boolean): unknown;
export function assertTutorAppMapping(mapping: unknown, appId: string, allowMigratedAlias?: boolean): void;
export function assertTutorPackageManifestIdentity(manifest: unknown,
  expected: Readonly<{ name: string; displayName: string }>): void;
