'use strict';

// JSON 1.0: a form belongs at the card root and cannot directly contain div,
// table, chart, or another form. div is permitted inside a column in that form.
// This narrow preflight is not a replacement for Feishu's client renderer.
function validateFormStructure(card) {
  function visit(node, parent, inForm, names) {
    if (!node || typeof node !== 'object') throw new Error('invalid card component');
    if (node.tag === 'form') {
      if (parent !== card || inForm || typeof node.name !== 'string' || !node.name || !Array.isArray(node.elements))
        throw new Error('invalid form placement');
      const formNames = new Set([node.name]);
      if (node.elements.some(child => ['div','table','chart','form'].includes(child?.tag)))
        throw new Error('unsupported direct form child');
      for (const child of node.elements) visit(child, node, true, formNames);
      if (!node.elements.some(child => child.tag === 'button' && child.action_type === 'form_submit'))
        throw new Error('form submit button missing');
      return;
    }
    if (inForm && ['table','chart'].includes(node.tag)) throw new Error('unsupported component in form');
    if (inForm && ['input','select_static','button'].includes(node.tag)) {
      if (typeof node.name !== 'string' || !node.name || names.has(node.name)) throw new Error('missing or duplicate form field');
      names.add(node.name);
    }
    for (const key of ['elements','columns','actions']) for (const child of node[key] || []) visit(child,node,inForm,names);
  }
  for (const node of card.elements || []) visit(node,card,false,null);
  return card;
}
module.exports = { validateFormStructure };
