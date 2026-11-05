import { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import {
  groupByProvider,
  modelKey,
  modelsApi,
  parseModelKey,
  type ModelInfo,
  type ModelRef,
} from '../chat/models';

interface ModelPickerProps {
  /** The model in use (or the default). Null means Pi's own choice. */
  value: ModelRef | null;
  onChange: (model: ModelRef) => void | Promise<void>;
  disabled?: boolean;
  /** Re-fetch when this changes, e.g. after a provider sign-in. */
  reloadKey?: unknown;
  label?: string;
  compact?: boolean;
}

/** Lists the models the signed-in providers offer and lets the user pick one. */
export function ModelPicker({
  value,
  onChange,
  disabled,
  reloadKey,
  label,
  compact,
}: ModelPickerProps) {
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      setModels((await modelsApi.list()).models);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load models');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      const { failed } = await modelsApi.refresh();
      await load();
      if (failed.length > 0)
        setError(`Could not refresh: ${failed.join(', ')}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Refresh failed');
    } finally {
      setRefreshing(false);
    }
  };

  const choose = async (key: string) => {
    const model = parseModelKey(key);
    if (!model) return;
    try {
      await onChange(model);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not change the model');
    }
  };

  const known =
    value &&
    models?.some((m) => m.provider === value.provider && m.id === value.id);

  return (
    <div className="flex flex-col gap-1 min-w-0">
      <div className="flex items-center gap-2 min-w-0">
        {label && (
          <span className="text-xs text-zinc-400 shrink-0">{label}</span>
        )}
        <select
          aria-label={label ?? 'Model'}
          disabled={disabled || !models || models.length === 0}
          value={value ? modelKey(value) : ''}
          onChange={(e) => void choose(e.target.value)}
          className={`input-field rounded-lg px-2 text-zinc-100 focus:outline-none min-w-0 max-w-full truncate disabled:opacity-50 ${compact ? 'py-1 text-xs' : 'py-1.5 text-sm'}`}
        >
          {/* A model in use that is not (or no longer) offered still shows, so the control never lies. */}
          {value && !known && (
            <option value={modelKey(value)}>
              {value.provider}/{value.id}
            </option>
          )}
          {!value && <option value="">Pi default</option>}
          {groupByProvider(models ?? []).map((g) => (
            <optgroup key={g.provider} label={g.providerName}>
              {g.models.map((m) => (
                <option key={modelKey(m)} value={modelKey(m)}>
                  {m.name}
                  {m.reasoning ? ' · reasoning' : ''}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <button
          type="button"
          title="Look for new models"
          aria-label="Refresh models"
          disabled={refreshing}
          onClick={() => void refresh()}
          className="p-1.5 rounded-md text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors disabled:opacity-50 shrink-0"
        >
          <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
        </button>
      </div>
      {models && models.length === 0 && (
        <p className="text-xs text-zinc-500">
          No models yet. Sign in to a provider under Settings.
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
