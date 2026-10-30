// Pure: fits a queue's Samples into at most `limit` points by cutting their
// time span into equal buckets: each keeps its last depth and time and its
// summed estimated arrivals (unknown only when every Sample in it is). Empty
// buckets leave no point, so a gap stays a gap.
export interface DownsampleInput {
  at: number;
  depth: number;
  estimatedArrivals: number | null;
}

export function downsample<S extends DownsampleInput>(samples: readonly S[], limit: number): S[] {
  if (samples.length <= limit) return [...samples];
  const first = samples[0]!.at;
  const width = (samples.at(-1)!.at - first + 1) / limit;
  const points: S[] = [];
  let bucket = -1;
  for (const sample of samples) {
    const index = Math.floor((sample.at - first) / width);
    const last = points.at(-1);
    if (index !== bucket || !last) {
      bucket = index;
      points.push({ ...sample });
    } else {
      const known = [last.estimatedArrivals, sample.estimatedArrivals].filter((n): n is number => n !== null);
      points[points.length - 1] = {
        ...sample,
        estimatedArrivals: known.length ? known.reduce((sum, n) => sum + n, 0) : null,
      };
    }
  }
  return points;
}
