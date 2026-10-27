import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import type { DisplaySnapshot, RendererReport } from "./schemas.js";
import { StateValidationError } from "./state-store.js";

export function tokenMatches(
  actual: string | undefined,
  expected: string,
): boolean {
  if (!actual) return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

interface Renderer {
  token: string;
  report?: RendererReport;
  reportedAt?: string;
}

export class Renderers {
  readonly #clients = new Map<string, Renderer>();

  connect(): { rendererId: string; token: string } {
    if (this.#clients.size >= 16)
      throw new StateValidationError(
        "Too many renderer connections",
        "renderer_limit",
      );
    const rendererId = randomUUID();
    const token = randomBytes(32).toString("hex");
    this.#clients.set(rendererId, { token });
    return { rendererId, token };
  }

  disconnect(rendererId: string): void {
    this.#clients.delete(rendererId);
  }

  report(
    rendererId: string,
    token: string | undefined,
    report: RendererReport,
    snapshot: DisplaySnapshot,
  ): void {
    const renderer = this.#clients.get(rendererId);
    if (!renderer || !tokenMatches(token, renderer.token))
      throw new StateValidationError(
        "Renderer reporting credential is invalid",
        "unauthorized",
      );
    if (report.revision !== snapshot.revision)
      throw new StateValidationError(
        "Snapshot changed; report the current revision",
        "stale_report",
      );
    const contentId =
      snapshot.view.type === "timer" ? undefined : snapshot.content?.id;
    if (report.contentId !== contentId || report.page > report.pageCount)
      throw new StateValidationError("Report does not match displayed content");
    renderer.report = structuredClone(report);
    renderer.reportedAt = new Date().toISOString();
  }

  delivery(snapshot: DisplaySnapshot) {
    const renderers = [...this.#clients.entries()].map(
      ([rendererId, renderer]) => ({
        rendererId,
        ...(renderer.report
          ? { ...renderer.report, reportedAt: renderer.reportedAt! }
          : {}),
        acknowledged:
          !!renderer.report &&
          renderer.report.visible &&
          renderer.report.revision === snapshot.revision &&
          Date.now() - Date.parse(renderer.reportedAt!) < 45_000,
      }),
    );
    return {
      status: renderers.some((renderer) => renderer.acknowledged)
        ? ("acknowledged" as const)
        : renderers.length
          ? ("pending" as const)
          : ("disconnected" as const),
      renderers,
    };
  }

  layout(
    snapshot: DisplaySnapshot,
    contentId: string,
  ): { page: number; pageCount: number } | undefined {
    const report = this.delivery(snapshot).renderers.find(
      (renderer) => renderer.acknowledged && renderer.contentId === contentId,
    );
    return report && report.page !== undefined && report.pageCount !== undefined
      ? { page: report.page, pageCount: report.pageCount }
      : undefined;
  }
}
