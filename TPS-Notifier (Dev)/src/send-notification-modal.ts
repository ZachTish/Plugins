import { App, Modal, Notice } from 'obsidian';

type SendNotificationHandler = (body: string, title?: string) => Promise<void>;

export class SendNotificationModal extends Modal {
    private title = '';
    private body = '';
    private readonly onSend: SendNotificationHandler;

    constructor(app: App, onSend: SendNotificationHandler) {
        super(app);
        this.onSend = onSend;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h2', { text: 'Send Custom Notification' });

        const container = contentEl.createDiv();
        container.style.display = 'flex';
        container.style.flexDirection = 'column';
        container.style.gap = '10px';

        const titleBlock = container.createDiv();
        titleBlock.createEl('label', { text: 'Title', cls: 'tps-messager-label' });
        const titleInput = titleBlock.createEl('input', { type: 'text', placeholder: 'Notification Title' });
        titleInput.style.width = '100%';
        titleInput.addEventListener('input', (event) => {
            this.title = (event.target as HTMLInputElement).value;
        });

        const bodyBlock = container.createDiv();
        bodyBlock.createEl('label', { text: 'Message', cls: 'tps-messager-label' });
        const bodyInput = bodyBlock.createEl('textarea', { placeholder: 'Message Body' });
        bodyInput.style.width = '100%';
        bodyInput.rows = 4;
        bodyInput.addEventListener('input', (event) => {
            this.body = (event.target as HTMLTextAreaElement).value;
        });

        const buttonContainer = container.createDiv();
        buttonContainer.style.display = 'flex';
        buttonContainer.style.justifyContent = 'flex-end';
        buttonContainer.style.marginTop = '15px';
        buttonContainer.style.gap = '10px';

        const cancelBtn = buttonContainer.createEl('button', { text: 'Cancel' });
        cancelBtn.addEventListener('click', () => this.close());

        const sendBtn = buttonContainer.createEl('button', { text: 'Send', cls: 'mod-cta' });
        sendBtn.addEventListener('click', async () => {
            if (!this.title && !this.body) {
                new Notice('Please provide a title or message body.');
                return;
            }
            await this.onSend(this.body, this.title);
            new Notice('Notification Sent');
            this.close();
        });
    }

    onClose() {
        this.contentEl.empty();
    }
}