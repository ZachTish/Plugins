import { Notice } from "obsidian";

export type NoticeVariant = "success" | "warning" | "loading";

interface ShowNoticeOptions {
  timeout?: number;
  variant?: NoticeVariant;
}

export function showNotice(message: string | DocumentFragment, options?: ShowNoticeOptions): Notice {
  const notice = new Notice(message, options?.timeout);
  const container = notice.containerEl;
  if (!container) {
    return notice;
  }

  if (options?.variant === "success") {
    container.addClass("mod-success");
  } else if (options?.variant === "warning") {
    container.addClass("mod-warning");
  } else if (options?.variant === "loading") {
    container.addClass("is-loading");
  }

  return notice;
}
