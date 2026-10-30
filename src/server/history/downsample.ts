// Pure: fits a queue's Samples into at most `limit` points by cutting their
// time span into equal buckets: each keeps its last depth and time and its
// summed estimated arrivals (unknown when every Sample in it is, and marked as
// partly unknown when only some are, so a short unknown stretch never vanishes
// at a long range). Empty buckets leave no point, so a gap stays a gap.
export interface DownsampleInput {
  at: number;
  depth: number;
  estimatedArrivals: number | null;
}

export type Downsampled<S> = S & {
  /** Some of the bucket's Samples, not all, have unknown arrivals: `estimatedArrivals` adds up the rest. */
  arrivalsPartlyUnknown?: true;
};

export function downsample<S extends DownsampleInput>(samples: readonly S[], limit: number): Array<Downsampled<S>> {
  if (samples.length <= limit) return [...samples];
  const first = samples[0]!.at;
  const width = (samples.at(-1)!.at - first + 1) / limit;
  const points: Array<Downsampled<S>> = [];
  let bucket = -1;
  let unknownInBucket = false;
  for (const sample of samples) {
    const index = Math.floor((sample.at - first) / width);
    const last = points.at(-1);
    if (index !== bucket || !last) {
      bucket = index;
      unknownInBucket = sample.estimatedArrivals === null;
      points.push({ ...sample });
    } else {
      unknownInBucket ||= sample.estimatedArrivals === null;
      const known = [last.estimatedArrivals, sample.estimatedArrivals].filter((n): n is number => n !== null);
      points[points.length - 1] = {
        ...sample,
        estimatedArrivals: known.length ? known.reduce((sum, n) => sum + n, 0) : null,
        ...(known.length && unknownInBucket ? { arrivalsPartlyUnknown: true as const } : {}),
      };
    }
  }
  return points;
}
