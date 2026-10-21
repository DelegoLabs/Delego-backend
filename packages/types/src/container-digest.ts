export interface ContainerDigestVerificationResult {
  imageName: string;
  expectedDigest: string;
  verified: boolean;
}
