import { useEffect, useMemo, useState } from 'react';
import { Drawer } from '../components/Drawer.tsx';
import { formatImageFragment, type ImageMeta } from '@nitrogen/core';

export interface PreparedImage {
  path: string;
  b64: string;
  markdown: string;
}

/** Downscale to maxPx on the longest side; re-encode to WebP (or JPEG) unless SVG/GIF. */
export async function downscale(file: File, maxPx: number): Promise<{ blob: Blob; ext: string }> {
  const ext = (file.name.split('.').pop() ?? '').toLowerCase();
  if (ext === 'svg' || file.type === 'image/svg+xml' || ext === 'gif') return { blob: file, ext: ext === 'gif' ? 'gif' : 'svg' };
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error('This image format cannot be decoded here. HEIC needs Safari; or export to JPEG first.');
  }
  const scale = Math.min(1, maxPx / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, w, h);
  const keepPng = ext === 'png' && scale === 1 && file.size < 400_000;
  const type = keepPng ? 'image/png' : 'image/webp';
  const blob = await new Promise<Blob>((res) => canvas.toBlob((b) => res(b!), type, 0.86));
  return { blob, ext: keepPng ? 'png' : blob.type === 'image/webp' ? 'webp' : 'jpg' };
}

async function hash6(b: Blob): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', await b.arrayBuffer());
  return [...new Uint8Array(d)].slice(0, 3).map((x) => x.toString(16).padStart(2, '0')).join('');
}

function toB64(b: ArrayBuffer): string {
  let s = '';
  const u = new Uint8Array(b);
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}

export function buildImageMarkdown(alt: string, path: string, meta: Partial<ImageMeta>, caption: string): string {
  const frag = formatImageFragment(meta);
  const cap = caption ? ` "${caption.replace(/"/g, "'")}"` : '';
  return `![${alt.replace(/[[\]]/g, '')}](/${path}${frag ? `#${frag}` : ''}${cap})`;
}

export function ImageDialog({ file, assetsDir, maxPx, onInsert, onClose }: { file: File; assetsDir: string; maxPx: number; onInsert: (img: PreparedImage) => void; onClose: () => void }) {
  const [alt, setAlt] = useState('');
  const [caption, setCaption] = useState('');
  const [align, setAlign] = useState<ImageMeta['align']>('center');
  const [width, setWidth] = useState(0);
  const [unit, setUnit] = useState<'px' | '%'>('%');
  const [wrap, setWrap] = useState(true);
  const [zoom, setZoom] = useState(true);
  const [border, setBorder] = useState(false);
  const [prepared, setPrepared] = useState<{ blob: Blob; ext: string; path: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const preview = useMemo(() => (prepared ? URL.createObjectURL(prepared.blob) : null), [prepared]);
  useEffect(() => {
    void (async () => {
      try {
        const { blob, ext } = await downscale(file, maxPx);
        const now = new Date();
        const slug = file.name.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'image';
        const path = `${assetsDir}/${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${slug}-${await hash6(blob)}.${ext}`;
        setPrepared({ blob, ext, path });
      } catch (e) {
        setError((e as Error).message);
      }
    })();
  }, [file, assetsDir, maxPx]);
  const meta: Partial<ImageMeta> = { align, ...(width ? { w: unit === '%' ? `${width}%` : String(width) } : {}), wrap, zoom, border };
  const md = prepared ? buildImageMarkdown(alt || 'Describe the image', prepared.path, meta, caption) : '';
  return (
    <Drawer title="Insert image" onClose={onClose}>
      {error && <p role="alert" style={{ color: 'var(--danger)' }}>{error}</p>}
      {preview && <img src={preview} alt="" style={{ maxWidth: '100%', maxHeight: 200, display: 'block', margin: '0 auto 12px' }} />}
      <div style={{ display: 'grid', gap: 10 }}>
        <label>Alt text (required) <input className="input" value={alt} onChange={(e) => setAlt(e.target.value)} autoFocus /></label>
        <label>Caption <input className="input" value={caption} onChange={(e) => setCaption(e.target.value)} /></label>
        <fieldset style={{ border: 0, padding: 0, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <legend style={{ fontSize: 14 }}>Align</legend>
          {(['left', 'center', 'right', 'full'] as const).map((a) => <button type="button" key={a} className="chip-toggle" aria-pressed={align === a} onClick={() => setAlign(a)}>{a}</button>)}
        </fieldset>
        <label>Width {width ? `${width}${unit}` : '(natural)'}
          <input type="range" min={0} max={unit === '%' ? 100 : 1200} step={unit === '%' ? 5 : 20} value={width} onChange={(e) => setWidth(Number(e.target.value))} style={{ width: '100%' }} />
        </label>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 14 }}>
          <label><input type="radio" checked={unit === '%'} onChange={() => { setUnit('%'); setWidth(0); }} /> percent</label>
          <label><input type="radio" checked={unit === 'px'} onChange={() => { setUnit('px'); setWidth(0); }} /> pixels</label>
          <label><input type="checkbox" checked={wrap} onChange={(e) => setWrap(e.target.checked)} /> Wrap text</label>
          <label><input type="checkbox" checked={zoom} onChange={(e) => setZoom(e.target.checked)} /> Click to zoom</label>
          <label><input type="checkbox" checked={border} onChange={(e) => setBorder(e.target.checked)} /> Border</label>
        </div>
        <code style={{ fontSize: 12, overflowWrap: 'anywhere', background: 'var(--code-bg)', padding: 8, borderRadius: 6 }}>{md}</code>
        <button
          className="btn btn-primary"
          disabled={!prepared || !alt.trim()}
          onClick={async () => {
            if (!prepared) return;
            onInsert({ path: prepared.path, b64: toB64(await prepared.blob.arrayBuffer()), markdown: md });
          }}
        >
          Insert image
        </button>
        {prepared && prepared.blob.size > 8 * 1024 * 1024 && <p role="alert" style={{ color: 'var(--danger)' }}>The image is still larger than 8 MB after downscaling.</p>}
      </div>
    </Drawer>
  );
}
