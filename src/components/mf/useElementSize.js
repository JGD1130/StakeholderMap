// src/components/mf/useElementSize.js
//
// Measures an element's content box with ResizeObserver. Returns
// [ref, size] where size is { width, height } in whole CSS pixels, or null
// until the first measurement. Only updates state when a dimension actually
// changes, so a child that sizes itself from these numbers can't loop.
import { useCallback, useEffect, useRef, useState } from 'react';

export function useElementSize() {
  const [node, setNode] = useState(null);
  const [size, setSize] = useState(null);
  const lastRef = useRef(null);

  const ref = useCallback((el) => setNode(el), []);

  useEffect(() => {
    if (!node || typeof ResizeObserver === 'undefined') return undefined;
    const update = (width, height) => {
      const next = { width: Math.floor(width), height: Math.floor(height) };
      const last = lastRef.current;
      if (last && last.width === next.width && last.height === next.height) return;
      lastRef.current = next;
      setSize(next);
    };
    const rect = node.getBoundingClientRect();
    update(node.clientWidth || rect.width, node.clientHeight || rect.height);
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box) update(box.width, box.height);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);

  return [ref, size];
}
