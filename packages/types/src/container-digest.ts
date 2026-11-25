export interface ContainerDigestVerificationResult {
  imageName: string;
  expectedDigest: string;
  verified: boolean;
}

/**
 * Container Digest Verification
 * Used for verifying container image digests before rollout
 */
export interface ContainerDigestVerification {
  imageUri: string;
  digest: string;
  signedBy: string;
  verified: boolean;
}
