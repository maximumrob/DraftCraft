import { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { scriptAssetUrl } from '../utils/scriptAssetUrl';

export interface UnusedAsset {
  id: string;
  name: string;
}

function UnusedAssetsDialog({ items, onAnswer }: { items: UnusedAsset[]; onAnswer: (remove: boolean) => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onAnswer(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onAnswer]);

  return (
    <div className="dialog-overlay" role="dialog" aria-modal="true" aria-label="Unused pictures">
      <div className="dialog-box" style={{ maxWidth: 520 }}>
        <div className="dialog-header">Unused pictures</div>
        <div style={{ padding: '14px 20px', overflowY: 'auto' }}>
          <p style={{ marginTop: 0 }}>
            {items.length === 1 ? 'This picture is' : 'These pictures are'} not used anywhere in this script.
            {' '}{items.length === 1 ? 'It is' : 'They are'} the only thing keeping it from being a plain Final Draft (.fdx) file.
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, margin: '12px 0' }}>
            {items.map((u) => (
              <div key={u.id} style={{ width: 110, textAlign: 'center' }}>
                <img
                  src={scriptAssetUrl(u.id)}
                  alt={u.name}
                  style={{ width: 110, height: 110, objectFit: 'cover', borderRadius: 4, border: '1px solid var(--fd-border)' }}
                />
                <div style={{ fontSize: 12, marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={u.name}>
                  {u.name}
                </div>
              </div>
            ))}
          </div>
          <p style={{ marginBottom: 0 }}>Remove {items.length === 1 ? 'it' : 'them'}? This cannot be undone.</p>
        </div>
        <div className="dialog-footer">
          <button autoFocus onClick={() => onAnswer(false)}>Keep them</button>
          <button onClick={() => onAnswer(true)}>Remove them</button>
        </div>
      </div>
    </div>
  );
}

/** Shows the thumbnail dialog and resolves true for "Remove them", false for "Keep them" or Escape. */
export function askRemoveUnusedAssets(items: UnusedAsset[]): Promise<boolean> {
  return new Promise((resolve) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    let done = false;
    const finish = (answer: boolean) => {
      if (done) return;
      done = true;
      window.setTimeout(() => {
        root.unmount();
        host.remove();
      }, 0);
      resolve(answer);
    };
    root.render(<UnusedAssetsDialog items={items} onAnswer={finish} />);
  });
}
