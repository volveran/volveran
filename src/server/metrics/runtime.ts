// The standard process_* and nodejs_* metrics: CPU, memory, event-loop lag and start time.
import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { MetricFamily } from './exposition.js';

const RESOLUTION_MS = 10;
const startTimeSeconds = (Date.now() - process.uptime() * 1000) / 1000;

export interface RuntimeMetrics {
  families(): MetricFamily[];
  stop(): void;
}

export function startRuntimeMetrics(): RuntimeMetrics {
  const lag = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
  lag.enable();
  return {
    families() {
      const cpu = process.cpuUsage();
      const memory = process.memoryUsage();
      // The monitor's timer itself takes the resolution to fire: only what is beyond it is lag. NaN before its first reading.
      const lagSeconds = Math.max(0, lag.mean / 1e6 - RESOLUTION_MS) / 1000;
      lag.reset();
      return [
        counter('process_cpu_user_seconds_total', 'User CPU time spent, in seconds.', cpu.user / 1e6),
        counter('process_cpu_system_seconds_total', 'System CPU time spent, in seconds.', cpu.system / 1e6),
        gauge('process_resident_memory_bytes', 'Resident memory size, in bytes.', memory.rss),
        gauge('process_start_time_seconds', 'When the process started, in seconds since the Unix epoch.', startTimeSeconds),
        gauge('nodejs_heap_size_total_bytes', 'Size of the V8 heap, in bytes.', memory.heapTotal),
        gauge('nodejs_heap_size_used_bytes', 'Used size of the V8 heap, in bytes.', memory.heapUsed),
        gauge('nodejs_external_memory_bytes', 'Memory of C++ objects bound to JavaScript objects, in bytes.', memory.external),
        gauge('nodejs_eventloop_lag_seconds', 'Mean event-loop lag since the previous scrape, in seconds.', lagSeconds),
      ];
    },
    stop: () => lag.disable(),
  };
}

function gauge(name: string, help: string, value: number): MetricFamily {
  return { name, help, type: 'gauge', series: [{ value }] };
}

function counter(name: string, help: string, value: number): MetricFamily {
  return { name, help, type: 'counter', series: [{ value }] };
}
