import { describe, expect, it } from 'vitest';
import { PIPELINE_STAGE_NAMES, PipelineProfiler } from '../backend/lib/analysis-v1/pipeline-profiler';

describe('Pipeline 性能采集器', () => {
  it('用同一时钟标记并计算调用点耗时', () => {
    const ticks = [5, 9];
    const profiler = new PipelineProfiler(() => ticks.shift() ?? 9);

    const startedAt = profiler.mark();

    expect(profiler.elapsed(startedAt)).toBe(4);
    expect(profiler.snapshot().timerReads).toBe(2);
  });

  it('聚合稳定阶段、计数器、匿名文件和规则指标', async () => {
    const ticks = [10, 14, 20, 27, 30, 32, 40, 45];
    const profiler = new PipelineProfiler(() => ticks.shift() ?? 45);

    profiler.measure('input.recognition', () => undefined);
    await profiler.measureAsync('archive.extract', async () => undefined);
    profiler.recordElapsed('source.read', 3);
    profiler.increment('filesRead', 2);
    profiler.increment('bytesRead', 120);
    profiler.recordFile('private/device-a/syslog', 'kernel', { bytesRead: 100, decodedBytes: 180 });
    profiler.recordFile('private/device-b/sysinfo.json', 'sysinfo', { bytesRead: 20, decodedBytes: 20 });
    profiler.addFileMetrics('private/device-a/syslog', { linesProcessed: 9, parserDurationMs: 2, ruleDurationMs: 5, eventsCreated: 3, evidenceRetained: 3 });
    profiler.recordRule('storage.io.buffer', 5, true, 2);
    profiler.recordRule('storage.io.buffer', 4, false, 5);

    const profile = profiler.snapshot();

    expect(Object.keys(profile.stages)).toEqual(PIPELINE_STAGE_NAMES);
    expect(profile.stages['input.recognition']).toEqual({ durationMs: 4, invocations: 1 });
    expect(profile.stages['archive.extract']).toEqual({ durationMs: 7, invocations: 1 });
    expect(profile.stages['source.read']).toEqual({ durationMs: 3, invocations: 1 });
    expect(profile.counters).toMatchObject({ filesRead: 2, bytesRead: 120 });
    expect(profile.files).toEqual([
      { alias: 'kernel-01', sourceType: 'kernel', bytesRead: 100, decodedBytes: 180, linesProcessed: 9, readDurationMs: 0, parserDurationMs: 2, ruleDurationMs: 5, eventsCreated: 3, evidenceRetained: 3 },
      { alias: 'sysinfo-01', sourceType: 'sysinfo', bytesRead: 20, decodedBytes: 20, linesProcessed: 0, readDurationMs: 0, parserDurationMs: 0, ruleDurationMs: 0, eventsCreated: 0, evidenceRetained: 0 }
    ]);
    expect(JSON.stringify(profile)).not.toContain('private');
    expect(profile.rules).toEqual([{ ruleId: 'storage.io.buffer', invocations: 9, matches: 1, durationMs: 7 }]);
    expect(profile.timerReads).toBe(4);
  });
});
