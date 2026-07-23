import type { AiApiConfig, SnapshotDraft } from '../types';

export async function recognizeSnapshot(files: File[], signal?: AbortSignal, aiConfig?: AiApiConfig): Promise<SnapshotDraft> {
  if (!files.length) throw new Error('请先选择截图');
  if (files.length > 6) throw new Error('最多一次上传 6 张截图');

  const images = await Promise.all(files.map(async (file) => {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      throw new Error(`${file.name} 不是支持的图片格式`);
    }
    if (file.size > 6 * 1024 * 1024) {
      throw new Error(`${file.name} 超过 6MB`);
    }
    return {
      name: file.name,
      type: file.type,
      dataBase64: await fileToBase64(file),
    };
  }));

  const response = await fetch('/api/ocr-snapshot', {
    method: 'POST',
    signal,
    cache: 'no-store',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ images, ...(aiConfig?.apiKey ? { aiConfig } : {}) }),
  });
  const payload = await response.json() as { code: number; message?: string; data?: SnapshotDraft };
  if (!response.ok || payload.code !== 0 || !payload.data) {
    throw new Error(payload.message || `OCR 请求失败：${response.status}`);
  }
  return payload.data;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
    reader.onerror = () => reject(new Error(`${file.name} 读取失败`));
    reader.readAsDataURL(file);
  });
}
