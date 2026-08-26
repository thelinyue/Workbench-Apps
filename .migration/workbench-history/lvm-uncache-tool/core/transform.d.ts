export class LvmUncacheError extends Error {}

export interface LvmTransformResult {
  originalText: string;
  processedText: string;
  suggestedFilename: string;
  summary: {
    hasCache: boolean;
    cacheSegmentCount: number;
    cachePvNames: string[];
    cacheLvNames: string[];
    originNames: string[];
    changedSegments: number;
    removedKeys: number;
    removedPvNames: string[];
    removedLvNames: string[];
    warning: string;
  };
}

export function transformVgText(text: string, originalFilename?: string): LvmTransformResult;
