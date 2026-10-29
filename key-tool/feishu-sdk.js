'use strict';
const { randomUUID } = require('node:crypto');
function createClient(options, Lark = require('@larksuiteoapi/node-sdk')) {
  const ignore = () => {};
  // SDK failures may contain credentials, URL tickets or payloads. Never forward raw arguments.
  const logger = { error: () => options.onDiagnostic(), warn: () => options.onDiagnostic(), info: ignore, debug: ignore, trace: ignore };
  const dispatcher = new Lark.EventDispatcher({ logger, loggerLevel: Lark.LoggerLevel.error }).register(options.handlers);
  const client = new Lark.WSClient({
    appId: options.appId, appSecret: options.appSecret, domain: Lark.Domain.Feishu,
    autoReconnect: true, handshakeTimeoutMs: 12000, wsConfig: { pingTimeout: 20 },
    logger, loggerLevel: Lark.LoggerLevel.warn,
    onReady: options.onReady, onReconnected: options.onReconnected,
    onReconnecting: options.onReconnecting, onError: options.onError
  });
  const api = new Lark.Client({ appId: options.appId, appSecret: options.appSecret,
    logger, loggerLevel: Lark.LoggerLevel.error });
  return {
    start: () => client.start({ eventDispatcher: dispatcher }),
    close: params => client.close(params),
    getConnectionStatus: () => client.getConnectionStatus(),
    async sendText({ receiveIdType, receiveId, text }) {
      if (!['open_id', 'chat_id'].includes(receiveIdType) || typeof receiveId !== 'string' || !receiveId ||
          typeof text !== 'string' || !text || text.length > 4000) throw new Error('invalid message');
      const response = await api.im.message.create({ params: { receive_id_type: receiveIdType },
        data: { receive_id: receiveId, msg_type: 'text', content: JSON.stringify({ text }), uuid: randomUUID() } });
      if (response?.code !== 0 || !response?.data?.message_id) throw new Error('message delivery failed');
      return true;
    },
    async sendCard({ receiveIdType, receiveId, card }) {
      // Request controls must only be delivered to the initiating user's private chat.
      if (receiveIdType !== 'open_id' || typeof receiveId !== 'string' || !/^[\w:-]{4,256}$/.test(receiveId) ||
          !card || card.config?.enable_forward !== false || !Array.isArray(card.elements)) throw new Error('invalid card');
      const content = JSON.stringify(card);
      if (Buffer.byteLength(content, 'utf8') > 28000) throw new Error('card too large');
      const response = await api.im.message.create({ params: { receive_id_type: 'open_id' },
        data: { receive_id: receiveId, msg_type: 'interactive', content, uuid: randomUUID() } });
      if (response?.code !== 0 || typeof response?.data?.message_id !== 'string' || !response.data.message_id) throw new Error('card delivery failed');
      return { messageId: response.data.message_id };
    }
  };
}
module.exports = { createClient };
