import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Min } from 'class-validator';

export const DEFAULT_PAGE_SIZE = 20;

/**
 * The largest page this API will produce, whatever a caller asks for.
 *
 * `?size=100000` is a single request that reads the whole table, serialises it,
 * and holds it in memory — a denial of service that costs the attacker one
 * connection. The bound is enforced by clamping rather than by rejecting,
 * because a client asking for more than exists is not making a mistake, and a
 * 400 there is a worse answer than a full page.
 */
export const MAX_PAGE_SIZE = 100;

export class PageQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  /**
   * No `@Max` here on purpose — an over-large size is clamped in the service,
   * not refused. Zero and negatives are still rejected: those are malformed
   * rather than merely ambitious.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  size: number = DEFAULT_PAGE_SIZE;

  /**
   * `field` or `field,asc` / `field,desc`.
   *
   * Validated against a per-resource whitelist in the service rather than here,
   * so that every caller of the service is covered and not merely every caller
   * that arrives over HTTP.
   */
  @IsOptional()
  @IsString()
  sort?: string;
}
