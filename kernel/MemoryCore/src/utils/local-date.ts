/**
 * 本地时区的 YYYY-MM-DD。
 *
 * L0/L1/v2 三处曾各存一份逐字相同的拷贝——分片日期格式一旦漂移
 * （比如某处用了 UTC），跨层对账直接错位且极难发现。统一从这里出。
 */
export function formatLocalDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
