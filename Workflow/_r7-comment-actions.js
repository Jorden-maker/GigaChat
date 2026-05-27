// R7.19: добавляем 2 action'а в Plane workflow:
// - delete_comment — удалить комментарий по comment_id
// - update_comment — отредактировать комментарий по comment_id
const fs = require('fs');
const path = 'Workflow/plane-agent.json';
const j = JSON.parse(fs.readFileSync(path, 'utf8'));

// 1. Расширяем ALLOWED_ACTIONS в Валидации
const v = j.nodes.find(n => n.name === 'Валидация');
const oldAllowed = "const ALLOWED_ACTIONS = new Set(['list_projects','list_issues','create_issue','update_issue','delete_issue','search_issues','change_status','assign_issue','set_deadline','add_label','remove_label','add_comment','get_issue','bulk','stats','cross_project_search','list_comments','me','list_members','list_cycles','list_modules','list_notifications','list_activity','create_epic','chat']);";
const newAllowed = oldAllowed.replace("'chat'", "'delete_comment','update_comment','chat'");
if (v.parameters.jsCode.indexOf(oldAllowed) === -1) { console.error('Валидация ALLOWED not found'); process.exit(1); }
v.parameters.jsCode = v.parameters.jsCode.replace(oldAllowed, newAllowed);

// 2. Parse LLM — расширяем ALLOWED Set
const p = j.nodes.find(n => n.name === 'Parse LLM');
const pOld = "const ALLOWED = new Set(['list_projects','list_issues','create_issue','update_issue','delete_issue','search_issues','change_status','assign_issue','set_deadline','add_label','remove_label','add_comment','get_issue','bulk','stats','cross_project_search','list_comments','list_members','list_cycles','list_modules','list_notifications','list_activity','create_epic','me','chat']);";
const pNew = pOld.replace("'me','chat'", "'me','delete_comment','update_comment','chat'");
if (p.parameters.jsCode.indexOf(pOld) === -1) { console.error('Parse LLM ALLOWED not found'); process.exit(1); }
p.parameters.jsCode = p.parameters.jsCode.replace(pOld, pNew);

// 3. Stats handler — добавляем branches для delete_comment / update_comment
const h = j.nodes.find(n => n.name === 'Stats/CrossProject handler');
const insertAfter = "// === list_comments: GET";
const newBranches = `// === delete_comment: DELETE /api/v1/.../comments/{id}/ ===
if (action === 'delete_comment') {
  const allProjects = (src.projects && src.projects.length) ? src.projects : await getProjects.call(this);
  const projName = String(params.project_name || '').toLowerCase();
  const proj = allProjects.find(p => String(p.name).toLowerCase() === projName);
  if (!proj) return [{ json: { response: 'Проект не найден', action: 'delete_comment', data: null, error: 'project_not_found' } }];
  const issName = String(params.issue_name || '').toLowerCase();
  const issues = await getIssues.call(this, proj.id);
  const issue = issues.find(i => String(i.name || '').toLowerCase() === issName);
  if (!issue) return [{ json: { response: 'Задача не найдена', action: 'delete_comment', data: null, error: 'issue_not_found' } }];
  const commentId = String(params.comment_id || '');
  if (!commentId) return [{ json: { response: 'Не указан ID комментария', action: 'delete_comment', data: null, error: 'comment_id_required' } }];
  try {
    await this.helpers.httpRequest({
      method: 'DELETE',
      url: planeUrl + '/api/v1/workspaces/' + slug + '/projects/' + proj.id + '/issues/' + issue.id + '/comments/' + commentId + '/',
      headers: {'X-API-Key': planeToken, 'Content-Type': 'application/json'},
      timeout: 15000, json: true
    });
    return [{ json: { response: 'Комментарий удалён.', action: 'delete_comment', data: { deleted: true, comment_id: commentId } } }];
  } catch (e) {
    return [{ json: { response: 'Не удалось удалить комментарий: ' + (e.message || e), action: 'delete_comment', data: null, error: 'delete_failed' } }];
  }
}

// === update_comment: PATCH /api/v1/.../comments/{id}/ ===
if (action === 'update_comment') {
  const allProjects = (src.projects && src.projects.length) ? src.projects : await getProjects.call(this);
  const projName = String(params.project_name || '').toLowerCase();
  const proj = allProjects.find(p => String(p.name).toLowerCase() === projName);
  if (!proj) return [{ json: { response: 'Проект не найден', action: 'update_comment', data: null, error: 'project_not_found' } }];
  const issName = String(params.issue_name || '').toLowerCase();
  const issues = await getIssues.call(this, proj.id);
  const issue = issues.find(i => String(i.name || '').toLowerCase() === issName);
  if (!issue) return [{ json: { response: 'Задача не найдена', action: 'update_comment', data: null, error: 'issue_not_found' } }];
  const commentId = String(params.comment_id || '');
  if (!commentId) return [{ json: { response: 'Не указан ID комментария', action: 'update_comment', data: null, error: 'comment_id_required' } }];
  const newText = String(params.comment || params.text || '').trim();
  if (!newText) return [{ json: { response: 'Пустой текст комментария', action: 'update_comment', data: null, error: 'comment_text_required' } }];
  try {
    const r = await this.helpers.httpRequest({
      method: 'PATCH',
      url: planeUrl + '/api/v1/workspaces/' + slug + '/projects/' + proj.id + '/issues/' + issue.id + '/comments/' + commentId + '/',
      headers: {'X-API-Key': planeToken, 'Content-Type': 'application/json'},
      body: { comment_html: '<p>' + newText.replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c])) + '</p>' },
      timeout: 15000, json: true
    });
    return [{ json: { response: 'Комментарий обновлён.', action: 'update_comment', data: { updated: true, comment_id: commentId, comment: r } } }];
  } catch (e) {
    return [{ json: { response: 'Не удалось обновить комментарий: ' + (e.message || e), action: 'update_comment', data: null, error: 'update_failed' } }];
  }
}

// === list_comments: GET`;

if (h.parameters.jsCode.indexOf(insertAfter) === -1) { console.error('Stats handler list_comments anchor not found'); process.exit(1); }
h.parameters.jsCode = h.parameters.jsCode.replace(insertAfter, newBranches);

// 4. Switch — добавляем 2 правила (delete_comment, update_comment) перед chat
const sw = j.nodes.find(n => n.name === 'Switch action');
const rules = sw.parameters.rules.values;
const ruleTpl = (action, id) => ({
  conditions: {
    options: { caseSensitive: false, leftValue: '', typeValidation: 'loose', version: 3 },
    conditions: [{ leftValue: '={{ $json.action }}', rightValue: action, operator: { type: 'string', operation: 'equals' }, id: 'rule-' + id }],
    combinator: 'and'
  }
});
// Найти индекс правила chat (последнее)
const chatIdx = rules.findIndex(r => r.conditions.conditions[0].rightValue === 'chat');
// Вставить перед chat
rules.splice(chatIdx, 0, ruleTpl('delete_comment', 'delete_comment'));
rules.splice(chatIdx + 1, 0, ruleTpl('update_comment', 'update_comment'));
// Соответственно — добавить 2 connections перед chat connection
const conn = j.connections['Switch action'].main;
conn.splice(chatIdx, 0, [{ node: 'Stats/CrossProject handler', type: 'main', index: 0 }]);
conn.splice(chatIdx + 1, 0, [{ node: 'Stats/CrossProject handler', type: 'main', index: 0 }]);

// 5. Формат ответа — добавить delete_comment и update_comment в PASSTHROUGH_ACTIONS
const fo = j.nodes.find(n => n.name === 'Формат ответа');
const foOld = "const PASSTHROUGH_ACTIONS = new Set(['stats','cross_project_search','list_comments','me','list_members','list_cycles','list_modules','list_notifications','list_activity','create_epic','subscribe_issue','unsubscribe_issue','list_subscribers']);";
const foNew = foOld.replace("'list_subscribers'", "'list_subscribers','delete_comment','update_comment'");
if (fo.parameters.jsCode.indexOf(foOld) === -1) { console.error('Формат ответа PASSTHROUGH not found'); process.exit(1); }
fo.parameters.jsCode = fo.parameters.jsCode.replace(foOld, foNew);

fs.writeFileSync(path, JSON.stringify(j, null, 2), 'utf8');
console.log('OK: ALLOWED + Parse LLM + Stats handler + Switch (rules ' + rules.length + ', conn ' + conn.length + ') + Формат ответа');
