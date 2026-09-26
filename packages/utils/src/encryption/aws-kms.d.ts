/**
 * Ambient declaration for the optional @aws-sdk/client-kms dependency.
 *
 * The encryption module's aws_kms key provider lazily imports this package
 * at runtime, so @delegolabs/utils carries no hard aws-sdk dependency. The
 * consumer (e.g. @delegolabs/wallet) that installs the SDK provides these
 * types through its own node_modules; declaring the module shape here keeps
 * typechecking green without the package installed.
 */

declare module "@aws-sdk/client-kms" {
  export class KMSClient {
    constructor(config: { region?: string });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    send(command: any): Promise<any>;
  }
  export class DecryptCommand {
    constructor(input: {
      CiphertextBlob: Buffer;
      KeyId?: string;
    });
  }
  export class GenerateDataKeyCommand {
    constructor(input: { KeyId: string; KeySpec: "AES_256" });
  }
}