// 받은 소리 파일을 풀어 메모리에 들고 있는다 (같은 파일을 두 번 받지 않게)
import { api, type Identity } from '../api';
import { decodeWithLead } from './codec';
import { getCtx } from './context';

const buffers = new Map<string, Promise<AudioBuffer>>();

export function loadAudio(code: string, blobId: string, who?: Identity | null): Promise<AudioBuffer> {
  let p = buffers.get(blobId);
  if (!p) {
    p = api.blob(code, blobId, who).then((bytes) => decodeWithLead(bytes, getCtx()));
    buffers.set(blobId, p);
    p.catch(() => buffers.delete(blobId));
  }
  return p;
}

export function seedAudio(blobId: string, buffer: AudioBuffer): void {
  buffers.set(blobId, Promise.resolve(buffer));
}
