import { GuardError } from "../../domain/model/types.ts";

export function isReadyLikeStatus(status: string | undefined): boolean {
  return status === "ready" || status === "approved";
}

export function assertReadyLikeStatus(status: string | undefined, label: string): void {
  if (!isReadyLikeStatus(status)) {
    throw new GuardError(`${label}が ready ではありません（現在: ${status ?? "なし"}）`);
  }
}
