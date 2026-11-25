/**
 * SEP-0007 URI Generator (Issue #TBD)
 * 
 * Generates valid web+stellar:pay URIs for mobile Stellar wallet QR payments.
 * Compliant with SEP-0007 specification and RFC 3986 URI encoding.
 * 
 * Spec: https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0007.md
 * 
 * This file implements 1% of the feature: core URI encoding and parameter validation.
 */

/**
 * SEP-0007 URI parameters for payment operations.
 */
export interface Sep0007UriParams {
  /** Destination Stellar public key (G-address) */
  destination: string;
  /** Payment amount as decimal string */
  amount: string;
  /** Asset code (default: XLM for native asset) */
  assetCode?: string;
  /** Asset issuer public key (required for non-native assets) */
  assetIssuer?: string;
  /** Optional memo attached to the transaction */
  memo?: string;
  /** Memo type: text, id, or hash */
  memoType?: "text" | "id" | "hash";
  /** Backend callback webhook URL for instant payment notification */
  callbackUrl?: string;
  /** Optional message to display to the user */
  message?: string;
  /** Optional network passphrase (defaults to public network) */
  networkPassphrase?: string;
  /** Optional origin domain for security */
  origin?: string;
}

/**
 * Result of URI generation with validation status.
 */
export interface UriGenerationResult {
  /** Whether URI generation was successful */
  success: boolean;
  /** Generated web+stellar:pay URI (if successful) */
  uri?: string;
  /** Error message (if failed) */
  error?: string;
  /** Validation warnings (non-fatal issues) */
  warnings?: string[];
}

/**
 * SEP-0007 URI Generator for Stellar mobile wallet QR payments.
 * 
 * Generates RFC 3986 compliant URIs with proper parameter encoding,
 * destination validation, and callback webhook support.
 */
export class Sep0007UriGenerator {
  /**
   * Generates a SEP-0007 compliant web+stellar:pay URI.
   * 
   * @param params - Payment parameters
   * @returns Generation result with URI or error
   * 
   * @example
   * ```typescript
   * const generator = new Sep0007UriGenerator();
   * const result = generator.generatePaymentUri({
   *   destination: 'GAQAAAA...',
   *   amount: '10.50',
   *   assetCode: 'USD',
   *   memo: 'Invoice #12345',
   *   callbackUrl: 'https://api.example.com/webhooks/payment'
   * });
   * 
   * if (result.success) {
   *   console.log(result.uri);
   *   // web+stellar:pay?destination=GAQAAAA...&amount=10.50&...
   * }
   * ```
   */
  generatePaymentUri(params: Sep0007UriParams): UriGenerationResult {
    const warnings: string[] = [];

    // Validate required parameters
    const validation = this.validateParams(params);
    if (!validation.valid) {
      return {
        success: false,
        error: validation.error,
      };
    }

    try {
      // Build URI with encoded parameters
      const uri = this.buildUri(params, warnings);

      return {
        success: true,
        uri,
        warnings: warnings.length > 0 ? warnings : undefined,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error generating URI",
      };
    }
  }

  /**
   * Validates SEP-0007 parameters.
   * 
   * @param params - Parameters to validate
   * @returns Validation result
   */
  private validateParams(params: Sep0007UriParams): { valid: boolean; error?: string } {
    // Validate destination (required)
    if (!params.destination || typeof params.destination !== "string") {
      return { valid: false, error: "destination is required and must be a string" };
    }

    // Basic Stellar address format check (G followed by 55 alphanumeric characters)
    // Full StrKey validation will be added in future implementation
    if (!this.isValidStellarAddressFormat(params.destination)) {
      return {
        valid: false,
        error: `Invalid destination address format: ${params.destination}`,
      };
    }

    // Validate amount (required)
    if (!params.amount || typeof params.amount !== "string") {
      return { valid: false, error: "amount is required and must be a string" };
    }

    // Validate amount is a positive number
    const amountNum = parseFloat(params.amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      return { valid: false, error: `Invalid amount: ${params.amount}. Must be a positive number.` };
    }

    // Validate asset issuer required for non-native assets
    if (params.assetCode && params.assetCode.toUpperCase() !== "XLM") {
      if (!params.assetIssuer) {
        return {
          valid: false,
          error: `assetIssuer is required when assetCode is not XLM`,
        };
      }

      if (!this.isValidStellarAddressFormat(params.assetIssuer)) {
        return {
          valid: false,
          error: `Invalid assetIssuer address format: ${params.assetIssuer}`,
        };
      }
    }

    // Validate memo type
    if (params.memo && params.memoType) {
      const validMemoTypes = ["text", "id", "hash"];
      if (!validMemoTypes.includes(params.memoType)) {
        return {
          valid: false,
          error: `Invalid memoType: ${params.memoType}. Must be one of: ${validMemoTypes.join(", ")}`,
        };
      }

      // Validate memo format based on type
      if (params.memoType === "id") {
        const memoId = parseInt(params.memo, 10);
        if (isNaN(memoId) || memoId < 0) {
          return {
            valid: false,
            error: `Invalid memo for type 'id': must be a non-negative integer`,
          };
        }
      }

      if (params.memoType === "hash" && params.memo.length !== 64) {
        return {
          valid: false,
          error: `Invalid memo for type 'hash': must be 64 hex characters`,
        };
      }
    }

    // Validate callback URL format
    if (params.callbackUrl) {
      try {
        new URL(params.callbackUrl);
      } catch {
        return {
          valid: false,
          error: `Invalid callbackUrl format: ${params.callbackUrl}`,
        };
      }
    }

    return { valid: true };
  }

  /**
   * Builds the web+stellar:pay URI with encoded parameters.
   * 
   * @param params - Payment parameters
   * @param warnings - Array to collect non-fatal warnings
   * @returns Complete SEP-0007 URI
   */
  private buildUri(params: Sep0007UriParams, warnings: string[]): string {
    const queryParams: string[] = [];

    // Add destination (required)
    queryParams.push(`destination=${this.encodeUriComponent(params.destination)}`);

    // Add amount (required)
    queryParams.push(`amount=${this.encodeUriComponent(params.amount)}`);

    // Add asset code (optional, defaults to XLM)
    if (params.assetCode) {
      queryParams.push(`asset_code=${this.encodeUriComponent(params.assetCode)}`);

      // Add asset issuer for non-native assets
      if (params.assetCode.toUpperCase() !== "XLM" && params.assetIssuer) {
        queryParams.push(`asset_issuer=${this.encodeUriComponent(params.assetIssuer)}`);
      }
    }

    // Add memo (optional)
    if (params.memo) {
      // Encode memo safely to prevent truncation
      const encodedMemo = this.encodeUriComponent(params.memo);
      queryParams.push(`memo=${encodedMemo}`);

      // Add memo type (defaults to text if not specified)
      const memoType = params.memoType || "text";
      queryParams.push(`memo_type=${memoType}`);

      // Warn if memo is very long
      if (params.memo.length > 28 && params.memoType === "text") {
        warnings.push("Text memo exceeds 28 characters and may be truncated by some wallets");
      }
    }

    // Add callback URL (optional)
    if (params.callbackUrl) {
      queryParams.push(`callback=${this.encodeUriComponent(params.callbackUrl)}`);
    }

    // Add message (optional)
    if (params.message) {
      queryParams.push(`msg=${this.encodeUriComponent(params.message)}`);
    }

    // Add network passphrase (optional)
    if (params.networkPassphrase) {
      queryParams.push(`network_passphrase=${this.encodeUriComponent(params.networkPassphrase)}`);
    }

    // Add origin (optional)
    if (params.origin) {
      queryParams.push(`origin_domain=${this.encodeUriComponent(params.origin)}`);
    }

    // Construct final URI
    const uri = `web+stellar:pay?${queryParams.join("&")}`;

    return uri;
  }

  /**
   * Encodes a URI component according to RFC 3986.
   * Ensures special characters are properly encoded.
   * 
   * @param value - Value to encode
   * @returns RFC 3986 encoded string
   */
  private encodeUriComponent(value: string): string {
    return encodeURIComponent(value)
      .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  }

  /**
   * Basic Stellar address format validation.
   * Full StrKey validation will be added in future implementation.
   * 
   * @param address - Address to validate
   * @returns Whether address matches Stellar format
   */
  private isValidStellarAddressFormat(address: string): boolean {
    // Stellar addresses start with G and are 56 characters long
    return /^G[A-Z2-7]{55}$/.test(address);
  }

  /**
   * Decodes a SEP-0007 URI back into parameters (for testing/validation).
   * 
   * @param uri - web+stellar:pay URI to decode
   * @returns Decoded parameters or null if invalid
   */
  decodePaymentUri(uri: string): Sep0007UriParams | null {
    try {
      // Check for correct scheme
      if (!uri.startsWith("web+stellar:pay?")) {
        return null;
      }

      // Extract query string
      const queryString = uri.substring("web+stellar:pay?".length);
      const searchParams = new URLSearchParams(queryString);

      // Extract and decode parameters
      const destination = searchParams.get("destination");
      const amount = searchParams.get("amount");

      if (!destination || !amount) {
        return null;
      }

      const params: Sep0007UriParams = {
        destination,
        amount,
      };

      // Optional parameters
      if (searchParams.has("asset_code")) {
        params.assetCode = searchParams.get("asset_code")!;
      }

      if (searchParams.has("asset_issuer")) {
        params.assetIssuer = searchParams.get("asset_issuer")!;
      }

      if (searchParams.has("memo")) {
        params.memo = searchParams.get("memo")!;
      }

      if (searchParams.has("memo_type")) {
        params.memoType = searchParams.get("memo_type") as "text" | "id" | "hash";
      }

      if (searchParams.has("callback")) {
        params.callbackUrl = searchParams.get("callback")!;
      }

      if (searchParams.has("msg")) {
        params.message = searchParams.get("msg")!;
      }

      if (searchParams.has("network_passphrase")) {
        params.networkPassphrase = searchParams.get("network_passphrase")!;
      }

      if (searchParams.has("origin_domain")) {
        params.origin = searchParams.get("origin_domain")!;
      }

      return params;
    } catch {
      return null;
    }
  }
}
