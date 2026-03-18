import { useRef, useState } from 'react';
import { Layout, Printer, Download, Check, Copy, X } from 'lucide-react';

export interface CanvasData {
  html: string;
  css: string;
  js: string;
}

interface CanvasSidebarProps {
  canvasData: CanvasData;
  onClose: () => void;
}

export function CanvasSidebar({ canvasData, onClose }: CanvasSidebarProps) {
  const [isCopied, setIsCopied] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const getFullCanvasHtml = () => `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
      ${canvasData.css || ''}
    </style>
  </head>
  <body>
    ${canvasData.html || ''}
    <script>
      try {
        ${canvasData.js || ''}
      } catch (err) {
        console.error('Canvas JS Error:', err);
      }
    </script>
  </body>
</html>`;

  const handlePrint = () => {
    if (iframeRef.current?.contentWindow) {
      iframeRef.current.contentWindow.print();
    }
  };

  const handleDownload = () => {
    const html = getFullCanvasHtml();
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'canvas-export.html';
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleCopy = async () => {
    const html = getFullCanvasHtml();
    try {
      await navigator.clipboard.writeText(html);
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy to clipboard', err);
    }
  };

  return (
    <aside className="hidden md:flex flex-col w-1/2 lg:w-1/3 h-full bg-zinc-950/95 backdrop-blur-md z-10 shrink-0 border-l border-zinc-900 transition-all">
      <header className="flex items-center justify-between px-6 py-4 border-b border-zinc-900 header-gradient shrink-0">
        <h2 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
          <Layout size={20} className="text-indigo-400" />
          Interactive Canvas
        </h2>

        <div className="flex items-center gap-1">
          <button
            onClick={handlePrint}
            className="p-1.5 rounded-md text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors"
            title="Print Canvas"
          >
            <Printer size={16} />
          </button>
          <button
            onClick={handleDownload}
            className="p-1.5 rounded-md text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors"
            title="Download Code"
          >
            <Download size={16} />
          </button>
          <button
            onClick={handleCopy}
            className="p-1.5 rounded-md text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors"
            title="Copy Full Code"
          >
            {isCopied ? (
              <Check size={16} className="text-teal-400" />
            ) : (
              <Copy size={16} />
            )}
          </button>
          <div className="w-px h-4 bg-zinc-800 mx-2" />
          <button
            onClick={onClose}
            className="p-1.5 rounded-md text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors"
            title="Close Panel"
          >
            <X size={18} />
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto h-full w-full custom-scrollbar relative">
        <div className="w-full h-full bg-white relative">
          <iframe
            ref={iframeRef}
            title="Interactive Canvas"
            className="w-full h-full border-none"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
            srcDoc={getFullCanvasHtml()}
          />
        </div>
      </div>
    </aside>
  );
}
