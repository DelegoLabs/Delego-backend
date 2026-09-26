/**
 * Storefront / merchant product catalog types (Issue #112).
 */

export type ProductSortOption = "price_asc" | "price_desc" | "newest";

export interface Product {
  id: string;
  merchantId: string;
  name: string;
  description?: string;
  priceStroops: string;
  currency: string;
  category?: string;
  imageUrl?: string;
  stockQuantity: number;
  attributes?: Record<string, unknown>;
  createdAt: string;
  updatedAt?: string;
}

export interface StorefrontQueryParams {
  cursor?: string; // Base64-encoded (created_at, id) for deterministic pagination
  limit?: number; // 1-50, default 20
  category?: string;
  minPrice?: string;
  maxPrice?: string;
  sort?: ProductSortOption;
}

export interface PaginatedProductsResponse {
  items: Product[];
  nextCursor: string | null;
  totalCount: number;
}

export interface ProductUpdate {
  name?: string;
  description?: string;
  priceStroops?: string;
  stockQuantity?: number;
  category?: string;
  imageUrl?: string;
  attributes?: Record<string, unknown>;
}
