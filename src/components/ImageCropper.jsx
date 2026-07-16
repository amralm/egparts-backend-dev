import { useState, useRef, useEffect, useCallback } from 'react';

export default function ImageCropper({ imageUrl, onCrop, onCancel, aspectRatio = 1 }) {
  const imgRef = useRef(null);
  const previewCanvasRef = useRef(null);
  const [ready, setReady] = useState(false);
  const [natural, setNatural] = useState({ w: 0, h: 0 });
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragStart, setDragStart] = useState(null);

  const CROP = 400;
  const containerW = CROP;
  const containerH = CROP / aspectRatio;

  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      setNatural({ w: img.naturalWidth, h: img.naturalHeight });
      imgRef.current = img;
      setReady(true);
    };
    img.src = imageUrl;
  }, [imageUrl]);

  const scale = ready ? Math.max(containerW / natural.w, containerH / natural.h) : 1;
  const dispW = natural.w * scale;
  const dispH = natural.h * scale;

  const minX = Math.min(0, containerW - dispW);
  const maxX = Math.max(0, containerW - dispW);
  const minY = Math.min(0, containerH - dispH);
  const maxY = Math.max(0, containerH - dispH);

  useEffect(() => {
    if (ready) {
      setOffset({
        x: (containerW - dispW) / 2,
        y: (containerH - dispH) / 2,
      });
    }
  }, [ready]);

  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

  const onPointerDown = useCallback((e) => {
    e.preventDefault();
    setDragStart({ x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y });
  }, [offset]);

  useEffect(() => {
    if (!dragStart) return;
    const onMove = (e) => {
      const dx = e.clientX - dragStart.x;
      const dy = e.clientY - dragStart.y;
      setOffset({
        x: clamp(dragStart.ox + dx, minX, maxX),
        y: clamp(dragStart.oy + dy, minY, maxY),
      });
    };
    const onUp = () => setDragStart(null);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [dragStart, minX, maxX, minY, maxY]);

  const OUT = 500;

  useEffect(() => {
    if (!ready || !previewCanvasRef.current) return;
    const ctx = previewCanvasRef.current.getContext('2d');
    const srcX = (-offset.x) / scale;
    const srcY = (-offset.y) / scale;
    const srcW = containerW / scale;
    const srcH = containerH / scale;
    ctx.clearRect(0, 0, OUT, OUT / aspectRatio);
    ctx.drawImage(imgRef.current, srcX, srcY, srcW, srcH, 0, 0, OUT, OUT / aspectRatio);
  }, [ready, offset, scale, aspectRatio]);

  const handleCrop = () => {
    const canvas = document.createElement('canvas');
    canvas.width = OUT;
    canvas.height = OUT / aspectRatio;
    const ctx = canvas.getContext('2d');
    const srcX = (-offset.x) / scale;
    const srcY = (-offset.y) / scale;
    const srcW = containerW / scale;
    const srcH = containerH / scale;
    ctx.drawImage(imgRef.current, srcX, srcY, srcW, srcH, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => {
      if (blob) onCrop(blob);
    }, 'image/jpeg', 0.92);
  };

  const skipCrop = () => {
    const canvas = document.createElement('canvas');
    canvas.width = OUT;
    canvas.height = OUT / aspectRatio;
    const ctx = canvas.getContext('2d');
    const scaleFit = Math.min(OUT / natural.w, (OUT / aspectRatio) / natural.h);
    const fw = natural.w * scaleFit;
    const fh = natural.h * scaleFit;
    const fx = (OUT - fw) / 2;
    const fy = ((OUT / aspectRatio) - fh) / 2;
    ctx.drawImage(imgRef.current, 0, 0, natural.w, natural.h, fx, fy, fw, fh);
    canvas.toBlob((blob) => {
      if (blob) onCrop(blob);
    }, 'image/jpeg', 0.92);
  };

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-[300] flex items-center justify-center p-4" dir="rtl">
      <div className="glass-panel p-6 rounded-xl border border-white/10 max-w-lg w-full shadow-[0_0_40px_rgba(0,0,0,0.8)]">
        <h3 className="text-xl font-bold text-on-surface mb-1 text-center">اقتصاص الصورة</h3>
        <p className="text-on-surface-variant text-sm text-center mb-4">اسحب الصورة لتحديد الجزء الذي سيظهر في البطاقات</p>

        <div
          className="relative mx-auto overflow-hidden rounded-lg cursor-grab active:cursor-grabbing border-2 border-primary/50 select-none touch-none"
          style={{ width: containerW, height: containerH }}
          onPointerDown={onPointerDown}
        >
          {ready ? (
            <img
              src={imageUrl}
              className="absolute pointer-events-none select-none"
              style={{
                width: dispW,
                height: dispH,
                left: offset.x,
                top: offset.y,
                userSelect: 'none',
                WebkitUserSelect: 'none',
              }}
              draggable={false}
              alt="crop"
            />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center text-on-surface-variant">
              جاري تحميل الصورة...
            </div>
          )}

          <svg viewBox="0 0 3 3" className="absolute inset-0 w-full h-full pointer-events-none">
            <line x1="1" y1="0" x2="1" y2="3" stroke="rgba(255,255,255,0.25)" strokeWidth="0.03" vectorEffect="non-scaling-stroke" />
            <line x1="2" y1="0" x2="2" y2="3" stroke="rgba(255,255,255,0.25)" strokeWidth="0.03" vectorEffect="non-scaling-stroke" />
            <line x1="0" y1="1" x2="3" y2="1" stroke="rgba(255,255,255,0.25)" strokeWidth="0.03" vectorEffect="non-scaling-stroke" />
            <line x1="0" y1="2" x2="3" y2="2" stroke="rgba(255,255,255,0.25)" strokeWidth="0.03" vectorEffect="non-scaling-stroke" />
          </svg>
        </div>

        {ready && (
          <div className="mt-4 flex flex-col items-center">
            <p className="text-on-surface-variant text-xs mb-2">معاينة (500×{OUT / aspectRatio} بكسل):</p>
            <canvas
              ref={previewCanvasRef}
              width={OUT}
              height={OUT / aspectRatio}
              className="rounded-lg border border-white/10 bg-surface-container"
              style={{ width: 100, height: 100 / aspectRatio }}
            />
          </div>
        )}

        <div className="flex justify-center gap-3 mt-6">
          <button onClick={onCancel} className="px-6 py-2 text-on-surface-variant hover:text-white transition-colors">إلغاء</button>
          <button onClick={skipCrop} className="px-4 py-2 text-on-surface-variant hover:text-primary text-sm transition-colors underline underline-offset-2">استخدام الصورة كاملة</button>
          <button onClick={handleCrop} className="px-8 py-2 bg-primary text-on-primary rounded-lg font-bold hover:bg-primary-fixed transition-colors shadow-[0_0_20px_rgba(255,153,0,0.4)]">
            تأكيد الاقتصاص
          </button>
        </div>
      </div>
    </div>
  );
}
