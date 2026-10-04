/* WorkHub Supabase browser adapter. Requires supabase-config.js and supabase-js v2. */
(async function () {
  const cfg = window.WORKHUB_SUPABASE;
  const configured = cfg && cfg.url && cfg.anonKey && !cfg.url.includes('YOUR_') && !cfg.anonKey.includes('YOUR_');
  if (!configured || !window.supabase?.createClient) {
    console.info('WorkHub is using browser demo storage. Add Supabase project values to connect cloud accounts.');
    return;
  }
  const client = window.supabase.createClient(cfg.url, cfg.anonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });
  window.workhubSupabase = client;
  const dbKey = 'wh_db';
  let syncing = false;
  let saveTimer;
  let currentAuthUser = null;
  const known = new Map();
  const entityKeys = ['jobs','applications','services','serviceRequests','bookings','gigs','gigApps','orders','messages','notifications','reviews','reports','feedback','payments','savedJobs'];
  const syntheticEmail = id => `member-${id}@workhub.invalid`;
  const entityPublic = new Set(['jobs','services','gigs','reviews']);
  function currentLocal() { try { return JSON.parse(localStorage.getItem(dbKey) || '{}'); } catch { return {}; } }
  function recordKey(entity, item) { return `${entity}:${String(item.id)}`; }
  function profileIdForEmail(email, users) {
    if (!email) return null;
    const normalized = String(email).toLowerCase();
    return users.find(u => String(u.email).toLowerCase() === normalized)?._authId || null;
  }
  function ownerEmail(entity, item, email) {
    if (entity === 'jobs') return item.ownerEmail;
    if (entity === 'services') return item.providerEmail;
    if (entity === 'gigs') return item.ownerEmail;
    if (entity === 'applications') return item.applicantEmail;
    if (entity === 'serviceRequests') return item.customerEmail;
    if (entity === 'bookings') return item.customerEmail;
    if (entity === 'gigApps') return item.applicantEmail;
    if (entity === 'orders') return item.actorEmail || item.workerEmail || item.ownerEmail;
    if (entity === 'messages') return item.from;
    if (entity === 'notifications') return item._cloudOwnerEmail || item._createdBy || email;
    if (entity === 'reviews') return item.email;
    if (entity === 'savedJobs') return item.email;
    if (entity === 'reports' || entity === 'feedback' || entity === 'payments') return item.email;
    return null;
  }
  function recipientEmail(entity, item, email) {
    if (entity === 'applications') return item.ownerEmail || null;
    if (entity === 'serviceRequests' || entity === 'bookings') return item.providerEmail || null;
    if (entity === 'gigApps') return item.ownerEmail || null;
    if (entity === 'orders') return item.recipientEmail || null;
    if (entity === 'messages') return item.to || null;
    if (entity === 'notifications') return item.email && item.email !== email ? item.email : null;
    return null;
  }
  function publicRecord(entity, item) { return entityPublic.has(entity) && item.status !== 'Closed'; }
  function mapProfile(p) {
    const isMe = p.id === currentAuthUser?.id;
    return {
      _authId: p.id,
      name: p.display_name,
      email: isMe ? currentAuthUser.email : syntheticEmail(p.id),
      role: p.role,
      profile: p.profile || {},
      employer: p.employer || {}
    };
  }
  function emailForId(id, users) {
    return users.find(u => u._authId === id)?.email || syntheticEmail(id);
  }
  async function getProfiles() {
    const { data, error } = await client.from('workhub_public_profiles').select('id,display_name,role,profile,employer,updated_at');
    if (error) throw error;
    return (data || []).map(mapProfile);
  }
  async function cloudLoad() {
    const { data: { user: authUser }, error: authError } = await client.auth.getUser();
    if (authError || !authUser) return;
    currentAuthUser = authUser;
    const [{ data: profile, error: profileError }, { data: rows, error: rowsError }, profiles] = await Promise.all([
      client.from('profiles').select('*').eq('id', authUser.id).single(),
      client.from('workhub_records').select('id,entity,record_key,owner_id,recipient_id,is_public,data,updated_at'),
      getProfiles()
    ]);
    if (profileError) throw profileError;
    if (rowsError) throw rowsError;
    if (profile.account_status === 'suspended') {
      await client.auth.signOut(); sessionStorage.removeItem('wh_user');
      throw new Error('This account is suspended. Contact WorkHub support.');
    }
    const mergedUsers = new Map(profiles.map(p => [p.email, p]));
    mergedUsers.set(authUser.email.toLowerCase(), mapProfile(profile));
    let visibleRows = rows || [];
    if (profile.role === 'Admin') {
      const [{ data: adminUsers, error: adminUsersError }, { data: adminRecords, error: adminRecordsError }] = await Promise.all([
        client.rpc('workhub_admin_list_users'), client.rpc('workhub_admin_list_records')
      ]);
      if (adminUsersError) throw adminUsersError;
      if (adminRecordsError) throw adminRecordsError;
      for (const u of adminUsers || []) mergedUsers.set(u.email.toLowerCase(), { _authId: u.user_id, name: u.display_name, email: u.email.toLowerCase(), role: u.role, suspended: u.account_status === 'suspended', profile: {}, employer: {} });
      const byId = new Set(visibleRows.map(r => r.id));
      visibleRows = [...visibleRows, ...(adminRecords || []).filter(r => !byId.has(r.record_id)).map(r => ({ id: r.record_id, entity: r.entity, record_key: r.record_key, owner_id: r.owner_id, is_public: r.is_public, data: r.data }))];
    }
    const db = currentLocal();
    db.users = [...mergedUsers.values()];
    for (const entity of entityKeys) {
      const cloudRows = visibleRows.filter(r => r.entity === entity);
      for (const row of cloudRows) known.set(`${entity}:${row.record_key}`, row);
      const base = (Array.isArray(db[entity]) ? db[entity] : []);
      const byKey = new Map(base.map(item => [String(item.id), item]));
      for (const row of cloudRows) {
        const item = { ...row.data, id: row.data?.id ?? row.record_key, _cloudOwnerId: row.owner_id, _cloudRecordId: row.id, is_public: row.is_public };
        if (entity === 'savedJobs') item.email = authUser.email.toLowerCase();
        if (entity === 'jobs') item.ownerEmail = emailForId(row.owner_id, [...mergedUsers.values()]);
        if (entity === 'services') item.providerEmail = emailForId(row.owner_id, [...mergedUsers.values()]);
        if (entity === 'gigs') item.ownerEmail = emailForId(row.owner_id, [...mergedUsers.values()]);
        if (entity === 'reviews') item.author = row.data.author || db.users?.find(u => u.email === emailForId(row.owner_id, [...mergedUsers.values()]))?.name || 'WorkHub member';
        // Rows addressed to the signed-in user may store a public synthetic email.
        // Translate recipient fields back to this account so inboxes and workflow tabs can find them.
        if (row.recipient_id === authUser.id) {
          if (entity === 'applications') item.ownerEmail = authUser.email.toLowerCase();
          if (entity === 'serviceRequests' || entity === 'bookings') item.providerEmail = authUser.email.toLowerCase();
          if (entity === 'gigApps') item.ownerEmail = authUser.email.toLowerCase();
          if (entity === 'orders') item.recipientEmail = authUser.email.toLowerCase();
          if (entity === 'messages') {
            item.to = authUser.email.toLowerCase();
            item.from = emailForId(row.owner_id, [...mergedUsers.values()]);
          }
          if (entity === 'notifications') item.email = authUser.email.toLowerCase();
        }
        if (row.owner_id === authUser.id) item._cloudOwnerEmail = authUser.email.toLowerCase();
        if (row.recipient_id === authUser.id && !item._cloudOwnerEmail) item._cloudOwnerEmail = syntheticEmail(row.owner_id);
        const targetKey = entity === 'savedJobs' ? 'saved' : entity;
        db[targetKey] = db[targetKey] || [];
        const existing = db[targetKey].findIndex(x => String(x.id) === String(item.id));
        if (existing >= 0) db[targetKey][existing] = { ...db[targetKey][existing], ...item };
        else db[targetKey].push(item);
      }
    }
    syncing = true;
    localStorage.setItem(dbKey, JSON.stringify(db));
    syncing = false;
    if (window.user) window.user = { name: profile.display_name, email: authUser.email, role: profile.role };
    sessionStorage.setItem('wh_user', JSON.stringify({ name: profile.display_name, email: authUser.email, role: profile.role }));
    const previousUid = sessionStorage.getItem('wh_cloud_uid');
    sessionStorage.setItem('wh_cloud_uid', authUser.id);
    if (previousUid !== authUser.id) { location.reload(); return; }
    if (typeof window.startApp === 'function') window.startApp();
  }
  async function syncProfile(db) {
    const me = (db.users || []).find(u => u.email?.toLowerCase() === currentAuthUser.email.toLowerCase());
    if (!me || me.role === 'Admin') return;
    const { error } = await client.from('profiles').update({
      display_name: me.name,
      profile: me.profile || {},
      employer: me.employer || {},
      is_public: db.settings?.[me.email]?.publicProfile !== false,
      updated_at: new Date().toISOString()
    }).eq('id', currentAuthUser.id);
    if (error) throw error;
  }
  async function syncDb() {
    if (syncing || !currentAuthUser) return;
    const db = currentLocal();
    const me = currentAuthUser.email.toLowerCase();
    const profiles = db.users || [];
    const wanted = new Set();
    for (const entity of entityKeys) {
      const items = entity === 'savedJobs' ? (db.saved || []) : (db[entity] || []);
      for (const item of items) {
        const key = recordKey(entity, item);
        const previous = known.get(key);
        const isOwned = previous ? previous.owner_id === currentAuthUser.id : ownerEmail(entity, item, me)?.toLowerCase() === me;
        if (!isOwned) {
          if (previous && previous.owner_id !== currentAuthUser.id && item.status && item.status !== previous.data?.status && ['applications','gigApps','serviceRequests','bookings','orders'].includes(entity)) {
            const { error } = await client.rpc('workhub_update_status', { p_entity: entity, p_record_key: String(item.id), p_status: String(item.status) });
            if (error) console.warn('Could not update shared workflow status:', error.message);
          }
          continue;
        }
        const uid = previous?.owner_id || currentAuthUser.id;
        const targetEmail = recipientEmail(entity, item, me);
        const recipientId = profileIdForEmail(targetEmail, profiles) || (previous?.recipient_id ?? null);
        const payload = { ...item };
        delete payload._cloudOwnerId; delete payload._cloudRecordId; delete payload._cloudOwnerEmail;
        if (entity === 'jobs' || entity === 'services' || entity === 'gigs') delete payload.ownerEmail, delete payload.providerEmail;
        if (entity === 'reviews') delete payload.email;
        const row = { entity, record_key: String(item.id), owner_id: uid, recipient_id: recipientId, is_public: publicRecord(entity, item), data: payload, updated_at: new Date().toISOString() };
        const { data, error } = await client.from('workhub_records').upsert(row, { onConflict: 'owner_id,entity,record_key' }).select('id,entity,record_key,owner_id,recipient_id,is_public,data,updated_at').single();
        if (error) throw new Error(`Could not save ${entity} to Supabase: ${error.message}`);
        known.set(key, data); wanted.add(key);
      }
    }
    for (const [key, row] of known) {
      if (row.owner_id !== currentAuthUser.id || wanted.has(key)) continue;
      const [entity, ...parts] = key.split(':');
      const recordKey = parts.join(':');
      const items = entity === 'savedJobs' ? (db.saved || []) : (db[entity] || []);
      if (items.some(item => String(item.id) === recordKey)) continue;
      const { error } = await client.from('workhub_records').delete().eq('owner_id', currentAuthUser.id).eq('entity', entity).eq('record_key', recordKey);
      if (!error) known.delete(key);
    }
    await syncProfile(db);
  }
  window.workhubSyncNow = async function () {
    clearTimeout(saveTimer);
    if (!currentAuthUser) throw new Error('Your WorkHub session is not connected to Supabase. Sign out and sign back in, then try again.');
    await syncDb();
  };
  let lastSyncErrorAt = 0;
  function queueSync() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => syncDb().catch(e => {
      console.warn('WorkHub cloud sync:', e.message);
      if (Date.now() - lastSyncErrorAt > 12000) {
        lastSyncErrorAt = Date.now();
        window.toast?.('WorkHub could not save your change online. Check your connection and try again.');
      }
    }), 350);
  }

  // Keep the current UI's local-first interactions, and sync each local save to Supabase.
  const originalSetItem = Storage.prototype.setItem;
  Storage.prototype.setItem = function (key, value) {
    originalSetItem.call(this, key, value);
    if (key === dbKey && !syncing) queueSync();
  };

  // Use Supabase Auth instead of the demo's browser-only password store.
  const authForm = document.getElementById('authForm');
  authForm?.addEventListener('submit', async event => {
    event.preventDefault(); event.stopImmediatePropagation();
    const form = new FormData(authForm), email = String(form.get('email') || '').trim().toLowerCase(), password = String(form.get('password') || '');
    try {
      if (document.getElementById('signupTab')?.classList.contains('on')) {
        const redirectTo = location.href.split('?')[0].split('#')[0];
        const { data, error } = await client.auth.signUp({ email, password, options: { data: { display_name: String(form.get('name') || '').trim(), role: String(form.get('role') || 'Job seeker') }, emailRedirectTo: redirectTo } });
        if (error) throw error;
        if (!data.session) { alert('Check your email to confirm your WorkHub account, then sign in.'); return; }
      } else {
        const { error } = await client.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
      await client.auth.getSession();
      await cloudLoad();
      location.reload();
    } catch (error) { alert(error.message || 'Sign-in failed.'); }
  }, true);

  // Replace the local-only recovery prompt with Supabase's email recovery flow.
  window.workhubSendRecovery = async function () {
    const email = prompt('Email address for your WorkHub account:');
    if (!email) return;
    const { error } = await client.auth.resetPasswordForEmail(email.trim(), { redirectTo: location.href.split('?')[0].split('#')[0] });
    alert(error ? error.message : 'If the account exists, Supabase will email a password reset link.');
  };
  window.recover = window.workhubSendRecovery;
  document.querySelectorAll('[onclick="demoLogin()"],[onclick="demoAdmin()"],#authForm button[onclick^="demo"]').forEach(button => button.classList.add('hidden'));
  document.querySelectorAll('[onclick="logout()"]').forEach(button => button.addEventListener('click', async event => {
    event.preventDefault(); event.stopImmediatePropagation();
    await client.auth.signOut(); sessionStorage.removeItem('wh_user'); sessionStorage.removeItem('wh_cloud_uid'); location.reload();
  }, true));
  const originalDeleteJob = window.deleteJob;
  window.deleteJob = async function (id) {
    const profile = JSON.parse(localStorage.getItem(dbKey) || '{}').users?.find(u => u.email?.toLowerCase() === currentAuthUser.email.toLowerCase());
    const db = currentLocal();
    const job = (db.jobs || []).find(j => String(j.id) === String(id));
    if (profile?.role === 'Admin' && job?._cloudRecordId && job.ownerEmail?.toLowerCase() !== currentAuthUser.email.toLowerCase()) {
      if (!confirm('Remove this listing from WorkHub?')) return;
      const { error } = await client.rpc('workhub_admin_moderate_record', { p_record_id: job._cloudRecordId, p_action: 'remove', p_reason: 'Removed by platform administrator' });
      if (error) return alert(error.message);
      db.jobs = (db.jobs || []).filter(j => String(j.id) !== String(id));
      syncing = true; localStorage.setItem(dbKey, JSON.stringify(db)); syncing = false;
      location.reload(); return;
    }
    return originalDeleteJob?.(id);
  };
  window.toggleUser = async function (index) {
    const db = currentLocal(), target = db.users?.[index];
    if (!target?._authId) return alert('Could not identify that account. Refresh the admin page and try again.');
    const status = target.suspended ? 'active' : 'suspended';
    if (!confirm(`${status === 'suspended' ? 'Suspend' : 'Restore'} ${target.name}?`)) return;
    const { error } = await client.rpc('workhub_admin_set_account_status', { p_user_id: target._authId, p_status: status });
    if (error) return alert(error.message);
    location.reload();
  };
  window.workhubModerate = async function (entity, id, action) {
    const db = currentLocal();
    const item = (db[entity] || []).find(row => String(row.id) === String(id));
    if (!item?._cloudRecordId) return alert('Refresh the moderation page and try again.');
    const reason = action === 'remove' ? prompt('Reason for removal (optional):') || '' : '';
    const { error } = await client.rpc('workhub_admin_moderate_record', { p_record_id: item._cloudRecordId, p_action: action, p_reason: reason });
    if (error) return alert(error.message);
    location.reload();
  };
  window.moderation = function (view) {
    const db = currentLocal();
    const collections = [['jobs','Jobs'],['services','Services'],['gigs','Gigs'],['reviews','Reviews']];
    const entries = collections.flatMap(([key,label]) => (db[key] || []).map(item => ({ key,label,item })));
    view.innerHTML = `<div class="sectionhead"><div><h1>Content Moderation</h1><p>Review job, service, gig, and review listings.</p></div></div>` +
      (entries.length ? `<div class="table"><table><thead><tr><th>Type</th><th>Content</th><th>Visibility</th><th>Action</th></tr></thead><tbody>${entries.map(({key,label,item}) => `<tr><td>${label}</td><td><b>${esc(item.title || item.subject || item.company || 'Review')}</b><br><small>${esc(item.company || item.provider || item.owner || item.author || '')}</small></td><td><span class="pill">${item.is_public === false ? 'Hidden' : 'Visible'}</span></td><td>${item._cloudRecordId ? `<button class="lightbtn" onclick="workhubModerate('${key}','${esc(item.id)}','${item.is_public === false ? 'reinstate' : 'hide'}')">${item.is_public === false ? 'Restore' : 'Hide'}</button> <button class="lightbtn" onclick="workhubModerate('${key}','${esc(item.id)}','remove')">Remove</button>` : '<small>Local sample</small>'}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No community content to review.</div>');
  };
  window.workhubResolveReport = async function (recordId, status) {
    const { error } = await client.rpc('workhub_admin_resolve_report', { p_record_id: recordId, p_status: status });
    if (error) return alert(error.message);
    location.reload();
  };
  const originalReports = window.reports;
  window.reports = function (view) {
    const db = currentLocal();
    const me = (db.users || []).find(u => u.email?.toLowerCase() === currentAuthUser.email.toLowerCase());
    if (me?.role !== 'Admin') return originalReports?.(view);
    const reports = db.reports || [];
    view.innerHTML = `<div class="sectionhead"><div><h1>Reports and Complaints</h1><p>Review user reports and record outcomes.</p></div></div>` +
      (reports.length ? `<div class="table"><table><thead><tr><th>Report</th><th>Details</th><th>Status</th><th>Review</th></tr></thead><tbody>${reports.map(r => `<tr><td>${esc(r.subject)}</td><td>${esc(r.text)}</td><td><span class="pill">${esc(r.status || 'Under review')}</span></td><td>${r._cloudRecordId ? `<button class="lightbtn" onclick="workhubResolveReport('${r._cloudRecordId}','Resolved')">Resolve</button> <button class="lightbtn" onclick="workhubResolveReport('${r._cloudRecordId}','Dismissed')">Dismiss</button>` : '—'}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">There are no reports to review.</div>');
  };
  const authChange = client.auth.onAuthStateChange((event, session) => {
    if (!session && sessionStorage.getItem('wh_user')) {
      sessionStorage.removeItem('wh_user');
    }
    if (event === 'PASSWORD_RECOVERY') setTimeout(async () => {
      const password = prompt('Choose a new WorkHub password (at least 8 characters):');
      if (!password || password.length < 8) return alert('Password must be at least 8 characters. Request a new reset link to try again.');
      const { error } = await client.auth.updateUser({ password });
      alert(error ? error.message : 'Your password has been updated.');
    }, 0);
  });
  window.addEventListener('beforeunload', () => authChange.data.subscription.unsubscribe());

  try {
    const { data: { session } } = await client.auth.getSession();
    if (session) await cloudLoad();
    else if (sessionStorage.getItem('wh_user')) { sessionStorage.removeItem('wh_user'); location.reload(); return; }
    sessionStorage.removeItem('wh_live_refresh');
    client.channel('workhub-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'workhub_records' }, async () => {
        try { await cloudLoad(); if (sessionStorage.getItem('wh_live_refresh') !== '1') { sessionStorage.setItem('wh_live_refresh','1'); location.reload(); } }
        catch (error) { console.warn('WorkHub live update:', error.message); }
      }).subscribe();
  } catch (error) { console.error('WorkHub cloud setup:', error.message); }
  window.workhubCloudReady = true;
})();
