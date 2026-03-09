import { Copy, Edit2, Check } from 'lucide-react';
import { useState } from 'react';

interface UserMessageProps {
  content: string;
  onEdit: (newContent: string) => void;
}

export function UserMessage({ content, onEdit }: UserMessageProps) {
  const [isCopied, setIsCopied] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editedContent, setEditedContent] = useState(content);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(content);
    setIsCopied(true);
    setTimeout(() => setIsCopied(false), 2000);
  };

  const handleEditSubmit = () => {
    if (editedContent.trim()) {
      onEdit(editedContent);
      setIsEditing(false);
    }
  };

  const handleEditCancel = () => {
    setEditedContent(content);
    setIsEditing(false);
  };

  if (isEditing) {
    return (
      <div className="flex flex-col gap-2 max-w-[80%] items-end w-full ml-auto">
        <textarea
          value={editedContent}
          onChange={(e) => setEditedContent(e.target.value)}
          className="px-4 py-3 rounded-2xl rounded-tr-sm text-sm leading-relaxed w-full message-bubble-user resize-none focus:outline-none border border-zinc-700 bg-zinc-800 text-white"
          rows={Math.max(1, editedContent.split('\n').length)}
          autoFocus
        />
        <div className="flex gap-2">
          <button
            onClick={handleEditCancel}
            className="px-3 py-1 rounded-md text-xs bg-zinc-700 hover:bg-zinc-600 transition-colors text-zinc-100"
          >
            Cancel
          </button>
          <button
            onClick={handleEditSubmit}
            className="px-3 py-1 rounded-md text-xs send-button"
          >
            Submit
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-end w-full gap-2 group mb-4">
      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity duration-200 self-start py-2">
        <button
          onClick={handleCopy}
          className="p-2 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 rounded-full transition-all"
          title="Copy message"
        >
          {isCopied ? (
            <Check size={16} className="text-teal-300" />
          ) : (
            <Copy size={16} />
          )}
        </button>
        <button
          onClick={() => setIsEditing(true)}
          className="p-2 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 rounded-full transition-all"
          title="Edit"
        >
          <Edit2 size={16} />
        </button>
      </div>

      {/* Main Message Bubble */}
      <div className="max-w-[80%] px-4 py-3 rounded-2xl rounded-tr-sm text-sm leading-relaxed message-bubble-user">
        <p className="whitespace-pre-wrap">{content}</p>
      </div>
    </div>
  );
}
