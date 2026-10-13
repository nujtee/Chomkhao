import { isMissingSchema } from "./inventory.repository.ts";

/**
 * A deploy may run before its migration is applied (the site must keep working meanwhile — see the deploy-order
 * test). Reads that name a new column run `query`; while the column does not exist yet, `legacy` reads the same row
 * shape with the column's default as a constant.
 */
export async function withFallback<T>(query: () => Promise<T>, legacy: () => Promise<T>): Promise<T> {
  try {
    return await query();
  } catch (error) {
    if (!isMissingSchema(error)) throw error;
    return legacy();
  }
}
