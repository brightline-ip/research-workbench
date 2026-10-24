// Preserve input order and drain in-flight work before reporting a failure.
export async function mapConcurrent(items, limit, operation) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('Concurrency must be a positive integer');
  const results = new Array(items.length);
  let next = 0, failure;
  const workers = Array.from({length: Math.min(limit, items.length)}, async () => {
    while (!failure && next < items.length) {
      const index = next++;
      try { results[index] = await operation(items[index], index); }
      catch (error) { failure = error; }
    }
  });
  await Promise.all(workers);
  if (failure) throw failure;
  return results;
}
