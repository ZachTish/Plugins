import { WidgetType } from '@codemirror/view';

export const SOURCE_END_WIDGET_CLASS = 'tps-auto-base-embed-source-end-widget';
export const SOURCE_END_HOST_CLASS = 'tps-auto-base-embed-source-end-host';

export class SourceEndEmbedWidget extends WidgetType {
  constructor(private readonly filePath: string) {
    super();
  }

  eq(other: SourceEndEmbedWidget): boolean {
    return other.filePath === this.filePath;
  }

  toDOM(): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = SOURCE_END_WIDGET_CLASS;
    wrapper.dataset.filePath = this.filePath;

    const host = document.createElement('div');
    host.className = SOURCE_END_HOST_CLASS;
    host.dataset.filePath = this.filePath;
    host.dataset.inlinePlacement = 'after-content';
    wrapper.appendChild(host);
    return wrapper;
  }

  ignoreEvent(): boolean {
    return false;
  }
}