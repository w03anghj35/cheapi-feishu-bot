'use strict';

const { ToolError } = require('./service');
const { dayKey, beijingDay } = require('./daily-usage');
const { amount } = require('./recharge-query');

const UNIT = 100000000n;
const DAY_MS = 86400000;
const MAX_DAYS = 31;
const MAX_USERS = 50;
const MAX_RECORDS = 10000;
const MAX_DURATION_MS = 300000;
const fail = (code, message) => { throw new ToolError(code, message); };
const validId = value => Number.isSafeInteger(value) && value > 0;
const cleanName = value => typeof value === 'string' && value.length > 0 && value.length <= 200 &&
  !/[\x00-\x1f\x7f]/.test(value) ? value : null;

function dates(start, end) {
  dayKey(start); dayKey(end);
  const first = Date.parse(`${start}T00:00:00Z`), last = Date.parse(`${end}T00:00:00Z`);
  const count = (last - first) / DAY_MS + 1;
  if (!Number.isInteger(count) || count < 1 || count > MAX_DAYS)
    fail('INPUT', `分组用量一次只能查询连续 1 至 ${MAX_DAYS} 天。`);
  return Array.from({ length: count }, (_, index) =>
    new Date(first + index * DAY_MS).toISOString().slice(0, 10));
}
function scaledCost(raw) {
  let normalized;
  try { normalized = amount(raw); }
  catch { fail('SCHEMA', '使用记录金额不符合平台八位精度，未生成不完整分组表。'); }
  if (normalized.startsWith('-')) fail('SCHEMA', '使用记录出现负数实付，未生成不完整分组表。');
  const [whole, fraction = ''] = normalized.split('.');
  return BigInt(whole) * UNIT + BigInt(fraction.padEnd(8, '0'));
}
function format(value) {
  const whole = String(value / UNIT);
  const fraction = String(value % UNIT).padStart(8, '0').replace(/0+$/, '');
  return whole + (fraction ? `.${fraction}` : '');
}
function usageRoute(userId, page, start, end) {
  if (!validId(userId) || !Number.isInteger(page) || page < 1 || page > 100) fail('INPUT', '使用记录分页参数无效。');
  dayKey(start); dayKey(end);
  if (start > end) fail('INPUT', '使用记录日期范围无效。');
  return `/admin/usage?user_id=${userId}&page=${page}&page_size=100&start_date=${start}&end_date=${end}&timezone=Asia%2FShanghai&sort_by=created_at&sort_order=desc&exact_total=true`;
}
function groupKey(raw) {
  if (raw === null || raw === undefined) return 'ungrouped';
  if (!validId(raw)) fail('SCHEMA', '使用记录的分组 ID 无法核对。');
  return String(raw);
}
function publicGroup(raw) {
  if (!validId(raw?.id)) fail('SCHEMA', '平台分组目录含无效 ID。');
  return { id: raw.id, name: cleanName(raw.name) || `分组 ID ${raw.id}（名称未提供）` };
}

class GroupUsage {
  constructor({ request, ownership, now = () => Date.now(), maxUsers = MAX_USERS,
    maxRecords = MAX_RECORDS, maxDurationMs = MAX_DURATION_MS, onProgress = () => {} } = {}) {
    if (typeof request !== 'function' || !ownership || typeof ownership.admin !== 'function')
      throw Error('分组用量服务依赖无效。');
    Object.assign(this, { request, ownership, now, maxUsers, maxRecords, maxDurationMs, onProgress });
    this.busy = false;
  }
  async groupDirectory(checkTime) {
    const rows = [], seen = new Set(); let total;
    for (let page = 1; page <= 50; page++) {
      checkTime();
      const data = await this.request('GET', `/admin/groups?page=${page}&page_size=100`);
      if (!data || !Array.isArray(data.items) || !Number.isSafeInteger(data.total) || data.total < 0 ||
          data.total > 5000 || data.items.length > 100 || total !== undefined && total !== data.total)
        fail('SCHEMA', '平台分组目录分页不完整。');
      total = data.total;
      for (const raw of data.items) {
        const group = publicGroup(raw);
        if (seen.has(group.id)) fail('SCHEMA', '平台分组目录出现重复 ID。');
        seen.add(group.id); rows.push(group);
      }
      if (rows.length === total) return rows;
      if (!data.items.length || rows.length > total) fail('SCHEMA', '平台分组目录分页不完整。');
    }
    fail('LIMIT', '平台分组目录超出读取上限。');
  }
  async userAccess(userId, checkTime) {
    checkTime();
    try {
      const detail = await this.request('GET', `/admin/users/${userId}`);
      if (detail?.id !== userId || !Array.isArray(detail.allowed_groups) && detail.allowed_groups !== null ||
          typeof detail.restrict_public_groups !== 'boolean' ||
          detail.allowed_groups?.some(groupId => !validId(groupId)))
        return null;
      return { accessMode: detail.allowed_groups === null ? 'all-nonexclusive' : 'explicit',
        allowedIds: [...new Set(detail.allowed_groups || [])].sort((a, b) => a - b),
        restrictPublicGroups: detail.restrict_public_groups };
    } catch (error) {
      if (error?.code === 'AUTH' || error?.code === 'DENIED') throw error;
      return null;
    }
  }
  async query(input = {}) {
    if (this.busy) fail('BUSY', '已有分组用量查询正在进行。');
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).some(key => !['start', 'end', 'name'].includes(key)) ||
        input.name !== undefined && (typeof input.name !== 'string' || !input.name || input.name.length > 100))
      fail('INPUT', '分组用量查询条件无效。');
    const range = dates(input.start, input.end);
    this.busy = true;
    const started = this.now();
    const checkTime = () => { if (this.now() - started >= this.maxDurationMs)
      fail('LIMIT', '分组用量查询超过时间上限，未展示不完整结果。'); };
    try {
      const scope = await this.ownership.admin();
      const today = beijingDay(this.now());
      const currentProfiles = this.ownership.profiles();
      const datedProfiles = this.ownership.datedProfiles();
      if (input.name && !currentProfiles.some(profile => profile.name === input.name))
        fail('INPUT', '所选归属人已变化，请重新读取。');
      const applicable = new Map(range.map(day => [day, day > today ? [] :
        this.ownership.profilesAt(day).filter(profile => !input.name || profile.name === input.name)]));
      const ids = [...new Set([...applicable.values()].flatMap(profiles => profiles.flatMap(profile => profile.userIds)))];
      if (ids.length > this.maxUsers) fail('LIMIT', `本次分组查询超过 ${this.maxUsers} 个用户，请按归属人缩小范围。`);
      const directory = await this.ownership.users();
      const userById = new Map(directory.filter(user => user.role === 'user').map(user => [user.id, user]));
      if (ids.some(userId => !userById.has(userId)))
        fail('SCHEMA', '有历史归属用户已不在平台目录，无法完整读取分组用量。');
      const groups = await this.groupDirectory(checkTime);
      const groupById = new Map(groups.map(group => [String(group.id), group]));
      const access = new Map(), accessMissing = [];
      for (const userId of ids) {
        const item = await this.userAccess(userId, checkTime);
        access.set(userId, item);
        if (!item) accessMissing.push(userId);
      }
      const inRange = range.filter(day => day <= today);
      const firstDay = inRange[0], lastDay = inRange.at(-1);
      const amounts = new Map(), usedGroups = new Map(), logNames = new Map();
      let recordCount = 0;
      for (const [userIndex, userId] of ids.entries()) {
        const seen = new Set(); let total;
        if (!firstDay) break;
        for (let page = 1; page <= 100; page++) {
          checkTime();
          const data = await this.request('GET', usageRoute(userId, page, firstDay, lastDay));
          if (!data || !Array.isArray(data.items) || !Number.isSafeInteger(data.total) || data.total < 0 ||
              data.items.length > 100 || total !== undefined && total !== data.total ||
              recordCount + data.total > this.maxRecords)
            fail('LIMIT', '使用记录分页变化或超出上限，请缩小日期或归属范围。');
          total = data.total;
          for (const raw of data.items) {
            if (!validId(raw?.id) || seen.has(raw.id) || raw.user_id !== userId ||
                typeof raw.created_at !== 'string' || !Number.isFinite(Date.parse(raw.created_at)))
              fail('SCHEMA', '使用记录编号、用户或时间不一致，未展示不完整结果。');
            seen.add(raw.id);
            const day = beijingDay(Date.parse(raw.created_at));
            if (day < firstDay || day > lastDay)
              fail('SCHEMA', '使用记录日期超出请求范围，未展示不完整结果。');
            // The user may have joined this owner only partway through the range.
            // Logs outside every selected profile's membership must not surface.
            if (!applicable.get(day).some(profile => profile.userIds.includes(userId))) continue;
            const key = groupKey(raw.group_id);
            if (raw.group?.id != null && String(raw.group.id) !== key)
              fail('SCHEMA', '使用记录分组与分组详情不一致。');
            const name = cleanName(raw.group?.name);
            if (name && !logNames.has(key)) logNames.set(key, name);
            const units = scaledCost(raw.actual_cost);
            const bucket = `${userId}:${day}:${key}`;
            amounts.set(bucket, (amounts.get(bucket) || 0n) + units);
            usedGroups.set(userId, (usedGroups.get(userId) || new Set()).add(key));
          }
          if (seen.size === total) { recordCount += total; break; }
          if (!data.items.length || seen.size > total) fail('SCHEMA', '使用记录分页缺失，未展示不完整结果。');
          if (page === 100) fail('LIMIT', '单用户使用记录超过分页上限，请缩小日期范围。');
        }
        this.onProgress({ scannedUsers: userIndex + 1, totalUsers: ids.length, records: recordCount });
      }
      checkTime();
      const verified = await this.ownership.admin();
      if (verified.owner !== scope.owner || verified.groupId !== scope.groupId ||
          beijingDay(this.now()) !== today ||
          JSON.stringify(this.ownership.profiles()) !== JSON.stringify(currentProfiles) ||
          JSON.stringify(this.ownership.datedProfiles()) !== JSON.stringify(datedProfiles))
        fail('POLICY', '管理员、群、归属或日期已变化，未展示旧范围数据。');
      const rowsByKey = new Map();
      for (const day of range) for (const profile of applicable.get(day)) for (const userId of profile.userIds) {
        const rowKey = `${profile.name}:${userId}`;
        if (!rowsByKey.has(rowKey)) rowsByKey.set(rowKey, { name: profile.name, id: userId,
          email: userById.get(userId).email, values: Array(range.length).fill(null) });
        rowsByKey.get(rowKey).values[range.indexOf(day)] = {};
      }
      const rows = [...rowsByKey.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN') || a.id - b.id);
      const visibleGroupKeys = new Set();
      for (const row of rows) {
        const detail = access.get(row.id);
        row.restrictPublicGroups = detail?.restrictPublicGroups ?? null;
        row.accessMode = detail?.accessMode || 'unknown';
        row.allowedGroups = detail ? detail.allowedIds.map(groupId => {
          const group = groupById.get(String(groupId)) || { id: groupId, name: `分组 ID ${groupId}（当前名称未知）` };
          visibleGroupKeys.add(String(groupId)); return group;
        }) : null;
        const relevant = new Set([...(detail?.allowedIds || []).map(String), ...(usedGroups.get(row.id) || [])]);
        for (let index = 0; index < range.length; index++) {
          const values = row.values[index];
          if (values === null) continue;
          for (const key of relevant) {
            visibleGroupKeys.add(key);
            values[key] = format(amounts.get(`${row.id}:${range[index]}:${key}`) || 0n);
          }
        }
      }
      const selectedGroups = [...visibleGroupKeys].sort((a, b) => a === 'ungrouped' ? 1 : b === 'ungrouped' ? -1 : Number(a) - Number(b))
        .map(key => groupById.get(key) || { id: key === 'ungrouped' ? key : Number(key),
          name: key === 'ungrouped' ? '未分组' : logNames.get(key) || `分组 ID ${key}（当前名称未知）` });
      return { start: input.start, end: input.end, today, complete: true,
        days: range.map(day => ({ day, phase: day > today ? 'future' : day === today ? 'ongoing' : 'final' })),
        groups: selectedGroups, rows, scannedUsers: ids.length, records: recordCount,
        accessComplete: accessMissing.length === 0,
        accessWarning: accessMissing.length ? '部分账号当前授权分组未取得；历史实际分组用量仍按使用记录显示。' : null };
    } finally { this.busy = false; }
  }
}

module.exports = { GroupUsage, dates, usageRoute, scaledCost, format, groupKey, MAX_DAYS, MAX_USERS, MAX_RECORDS };
