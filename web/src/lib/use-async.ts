import { type DependencyList, useCallback, useEffect, useState } from 'react';

export interface AsyncState<T> {
  data: T | undefined;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/** Loads data on mount and when deps change; ignores late answers. */
export function useAsync<T>(load: () => Promise<T>, deps: DependencyList): AsyncState<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  // deps decide when to reload, as with useEffect; `load` itself changes every render.
  const run = useCallback(load, deps);

  useEffect(() => {
    let live = true;
    setLoading(true);
    run()
      .then((value) => live && (setData(value), setError(null)))
      .catch((err: unknown) => live && setError((err as Error).message))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [run, tick]);

  return { data, error, loading, reload: () => setTick((t) => t + 1) };
}
