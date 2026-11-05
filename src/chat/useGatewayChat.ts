import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { GatewayClient } from './gateway';
import { initialState, reduce } from './reducer';

export function useGatewayChat(conversationId: string) {
  const [state, dispatch] = useReducer(reduce, initialState);
  const [connected, setConnected] = useState(false);
  const client = useRef<GatewayClient | null>(null);

  useEffect(() => {
    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const gateway = new GatewayClient({
      url: `${scheme}://${window.location.host}/gateway`,
      conversationId,
      onEvent: dispatch,
      onConnection: setConnected,
    });
    client.current = gateway;
    gateway.connect();
    return () => {
      gateway.close();
      client.current = null;
    };
  }, [conversationId]);

  const sendMessage = useCallback(
    (text: string, profile?: string) =>
      client.current?.prompt(text, profile) ?? false,
    []
  );
  const stop = useCallback(() => void client.current?.abort(), []);
  const editMessage = useCallback(
    (entryId: string, text: string) =>
      client.current?.edit(entryId, text) ?? false,
    []
  );
  const setModel = useCallback(
    (provider: string, modelId: string) =>
      client.current?.setModel(provider, modelId) ?? false,
    []
  );
  const regenerate = useCallback(
    (entryId: string) => client.current?.regenerate(entryId) ?? false,
    []
  );
  const respondDialog = useCallback(
    (
      dialogId: string,
      answer: { value: string } | { confirmed: boolean } | { cancelled: true }
    ) => client.current?.respondDialog(dialogId, answer) ?? false,
    []
  );
  const dismissNotice = useCallback(
    () => dispatch({ type: 'dismiss_notice' }),
    []
  );
  const dismissUnsupported = useCallback(
    () => dispatch({ type: 'dismiss_unsupported' }),
    []
  );

  return {
    messages: state.messages,
    running: state.running,
    error: state.error,
    connected,
    sendMessage,
    stop,
    editMessage,
    regenerate,
    dialogs: state.dialogs,
    notice: state.notice,
    unsupported: state.unsupported,
    canvas: state.canvas,
    subagents: state.subagents,
    profile: state.profile,
    model: state.model,
    setModel,
    canvasRevision: state.canvasRevision,
    respondDialog,
    dismissNotice,
    dismissUnsupported,
  };
}
