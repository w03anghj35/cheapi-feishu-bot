'use strict';
const { randomUUID } = require('node:crypto');
const { validateFormStructure } = require('./feishu-card-validation');
function groupDeliveryError(kind, apiCode) {
  const error = new Error('group card delivery result unknown');
  error.groupDeliveryKind = kind;
  if (Number.isSafeInteger(apiCode) && apiCode >= 0 && apiCode <= 999999999) error.feishuCode = apiCode;
  return error;
}
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
    async listGroupMembers(chatId,pageToken) {
      if(!/^oc_[\w-]{8,128}$/.test(chatId)|| (pageToken!==undefined&&(typeof pageToken!=='string'||pageToken.length>4096)))throw new Error('invalid member query');
      try {
        const response=await api.im.chatMembers.get({path:{chat_id:chatId},params:{member_id_type:'open_id',page_size:100,...(pageToken?{page_token:pageToken}:{})}});
        if(response?.code!==0)throw {code:[99991672,99991679,232033,232011].includes(response?.code)?'DENIED':'API'};
        return response.data;
      } catch(error) {throw Object.assign(new Error('飞书成员姓名暂不可读取。'),{code:error?.code==='DENIED'||error?.response?.status===403?'DENIED':'API'});}
    },
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
      validateFormStructure(card);
      const content = JSON.stringify(card);
      if (Buffer.byteLength(content, 'utf8') > 28000) throw new Error('card too large');
      const response = await api.im.message.create({ params: { receive_id_type: 'open_id' },
        data: { receive_id: receiveId, msg_type: 'interactive', content, uuid: randomUUID() } });
      if (response?.code !== 0 || typeof response?.data?.message_id !== 'string' || !response.data.message_id) throw new Error('card delivery failed');
      return { messageId: response.data.message_id };
    },
    async sendGroupCard({ chatId, card }) {
      if (typeof chatId !== 'string' || !/^oc_[\w-]{8,128}$/.test(chatId) ||
          card?.config?.enable_forward !== false || !Array.isArray(card?.elements) ||
          card.elements.some(element => element?.tag === 'action' || element?.tag === 'form'))
        throw groupDeliveryError('local');
      const content = JSON.stringify(card);
      if (Buffer.byteLength(content, 'utf8') > 28000) throw groupDeliveryError('local');
      const response = await api.im.message.create({ params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, msg_type: 'interactive', content, uuid: randomUUID() } });
      if (response?.code !== 0 || !/^om_[\w-]{4,252}$/.test(response?.data?.message_id || ''))
        throw groupDeliveryError(Number.isSafeInteger(response?.code) && response.code > 0 ? 'api' : 'receipt', response?.code);
      return response.data.message_id;
    },
    async patchGroupCard({ messageId, card }) {
      if (typeof messageId !== 'string' || !/^om_[\w-]{4,252}$/.test(messageId) ||
          card?.config?.enable_forward !== false || !Array.isArray(card?.elements) ||
          card.elements.some(element => element?.tag === 'action' || element?.tag === 'form'))
        throw groupDeliveryError('local');
      const content = JSON.stringify(card);
      if (Buffer.byteLength(content, 'utf8') > 28000) throw groupDeliveryError('local');
      const response = await api.im.v1.message.patch({ path: { message_id: messageId }, data: { content } });
      if (response?.code !== 0)
        throw groupDeliveryError(Number.isSafeInteger(response?.code) && response.code > 0 ? 'api' : 'receipt', response?.code);
      return messageId;
    }
  };
}
module.exports = { createClient };
