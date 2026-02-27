import React, { useEffect, useRef, useState } from "react";
import { App, TFile } from "obsidian";
import { ContentRenderer } from "./content-renderer";

interface HoverEditorProps {
  file: TFile;
  position: { x: number; y: number };
  app: App;
  onSave: (content: string) => Promise<void>;
  onCancel: () => void;
}

/**
 * Floating hover editor for inline note editing.
 * Displays textarea with raw markdown (frontmatter hidden).
 * Preserves frontmatter on save.
 */
export const HoverEditor: React.FC<HoverEditorProps> = ({
  file,
  position,
  app,
  onSave,
  onCancel,
}) => {
  const [content, setContent] = useState("");
  const [originalContent, setOriginalContent] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const contentRendererRef = useRef(new ContentRenderer(app));

  // Load content on mount
  useEffect(() => {
    const loadContent = async () => {
      try {
        const fullContent = await app.vault.cachedRead(file);
        setOriginalContent(fullContent);

        const { body } =
          contentRendererRef.current.splitFrontmatter(fullContent);
        setContent(body);

        // Focus textarea after content loads
        setTimeout(() => {
          textareaRef.current?.focus();
        }, 50);
      } catch (error) {
        console.error("[PageBase] Error loading editor content:", error);
      }
    };

    void loadContent();
  }, [file, app]);

  const handleSave = async () => {
    if (isSaving) return;
    setIsSaving(true);

    try {
      const { frontmatter } =
        contentRendererRef.current.splitFrontmatter(originalContent);

      // Reconstruct full content with preserved frontmatter
      let newContent = content;
      if (frontmatter) {
        newContent = `${frontmatter.trimEnd()}\n\n${content.trimStart()}`;
      }

      await onSave(newContent);
    } catch (error) {
      console.error("[PageBase] Error saving content:", error);
    } finally {
      setIsSaving(false);
    }
  };

  const handleCancel = () => {
    onCancel();
  };

  const handleKeyDown = (evt: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // ESC to cancel
    if (evt.key === "Escape") {
      evt.preventDefault();
      handleCancel();
    }
    // Cmd/Ctrl+Enter to save
    if ((evt.metaKey || evt.ctrlKey) && evt.key === "Enter") {
      evt.preventDefault();
      void handleSave();
    }
  };

  return (
    <div
      className="bases-page-hover-editor"
      style={{
        left: `${position.x}px`,
        top: `${position.y}px`,
      }}
    >
      <div className="bases-page-hover-editor-header">
        <span className="bases-page-hover-editor-filename">
          {file.basename}
        </span>
      </div>

      <textarea
        ref={textareaRef}
        className="bases-page-hover-editor-textarea"
        value={content}
        onChange={(e) => setContent(e.currentTarget.value)}
        onKeyDown={handleKeyDown}
        placeholder="Enter markdown content..."
      />

      <div className="bases-page-hover-editor-actions">
        <button
          className="bases-page-hover-editor-action-cancel"
          onClick={handleCancel}
          disabled={isSaving}
        >
          Cancel
        </button>
        <button
          className="bases-page-hover-editor-action-save mod-cta"
          onClick={() => void handleSave()}
          disabled={isSaving}
        >
          {isSaving ? "Saving..." : "Save"}
        </button>
      </div>

      <div className="bases-page-hover-editor-hint">
        <small>
          ESC to cancel • <kbd>Cmd</kbd>+<kbd>Enter</kbd> to save
        </small>
      </div>
    </div>
  );
};
