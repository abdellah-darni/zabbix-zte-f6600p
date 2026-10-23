// Zabbix Script item: ZTE F6600P (Maroc Telecom) status collector
// Key: zte.status | Type of information: Text | Timeout: 20s | Interval: 5m
// Parameters: url = {$ZTE.URL}, user = {$ZTE.USER}, password = {$ZTE.PASSWORD}
//
// Tested on: ZTE ZXHN F6600P, firmware V9.0.10P8N4 (Maroc Telecom), Zabbix 7.0.31
//
// Flow (taken from the router's web UI):
//   1. GET  login_entry  -> sess_token (anti-forgery token)
//   2. GET  login_token  -> one-time number
//   3. POST login_entry  -> Password = sha256(password + number)
//   4. GET  /            -> the reload the router asks for (login_need_refresh)
//   5. For each page: GET menuView (open the page), then GET menuData (its data)
//   6. POST logout_entry (always, even after an error)
// Only the login and logout are POSTs: this script never changes router settings.

var p = JSON.parse(value);
var base = p.url.replace(/\/$/, '');
var sid = null;   // the router's session cookie (SID)

// One request object reused for every call: Zabbix allows at most 10
// HttpRequest objects per script run, and this script makes ~15 requests.
var req = new HttpRequest();

// One HTTP request, sending the SID cookie and remembering any new one
function call(method, path, body) {
    req.clearHeader();   // headers from the previous call must not carry over
    req.addHeader('X-Requested-With: XMLHttpRequest');
    if (sid) req.addHeader('Cookie: SID=' + sid);
    if (method === 'POST') req.addHeader('Content-Type: application/x-www-form-urlencoded');

    var resp = (method === 'POST') ? req.post(base + path, body) : req.get(base + path);
    if (req.getStatus() !== 200) throw 'HTTP ' + req.getStatus() + ' on ' + path;

    var headers = req.getHeaders(true);
    for (var name in headers) {
        if (name.toLowerCase() !== 'set-cookie') continue;
        headers[name].forEach(function (c) {
            var m = c.match(/SID=([^;]+)/);
            if (m) sid = m[1];
        });
    }
    return resp;
}

// <Instance><ParaName>X</ParaName><ParaValue>Y</ParaValue>...</Instance>
//   -> [{X: Y, ...}, ...]  (one object per Instance)
function instances(xml) {
    var out = [];
    xml.split('<Instance>').slice(1).forEach(function (block) {
        var obj = {}, m;
        var re = /<ParaName>([^<]*)<\/ParaName><ParaValue>([^<]*)<\/ParaValue>/g;
        while ((m = re.exec(block)) !== null) obj[m[1]] = m[2];
        out.push(obj);
    });
    return out;
}

// Open a page (view), then fetch one or more of its data endpoints
function page(view, dataTags) {
    call('GET', '/?_type=menuView&_tag=' + view + '&Menu3Location=0');
    return dataTags.map(function (tag) {
        var xml = call('GET', '/?_type=menuData&_tag=' + tag);
        if (xml.indexOf('SessionTimeout') !== -1) throw 'Router rejected the session on ' + tag;
        return instances(xml);
    });
}

var result = {};
var loggedIn = false;

try {
    // --- Login ---------------------------------------------------------------
    var sess = JSON.parse(call('GET', '/?_type=loginData&_tag=login_entry')).sess_token;
    var token = call('GET', '/?_type=loginData&_tag=login_token').replace(/<[^>]+>/g, '').trim();

    var login = JSON.parse(call('POST', '/?_type=loginData&_tag=login_entry',
        'action=login' +
        '&Password=' + sha256(p.password + token) +
        '&Username=' + encodeURIComponent(p.user) +
        '&_sessionTOKEN=' + encodeURIComponent(sess)));
    if (login.loginErrMsg) throw 'Login failed: ' + login.loginErrMsg;
    if (login.lockingTime) throw 'Login locked for ' + login.lockingTime + 's (too many failed attempts)';
    loggedIn = true;

    call('GET', '/');   // the reload the router asks for

    // --- Fiber (PON optical module) -----------------------------------------
    page('ponopticalinfo', ['optical_info_lua.lua'])[0].forEach(function (i) {
        if ('RxPower' in i) {
            result.rx_power   = parseFloat(i.RxPower);    // dBm received from the ISP
            result.tx_power   = parseFloat(i.TxPower);    // dBm sent to the ISP
            result.temp       = parseFloat(i.Temp);       // optical module temperature, C
            result.voltage_mv = parseFloat(i.Volt);
            result.bias_ma    = parseFloat(i.Current);
        }
        if ('LosInfo' in i)   result.los        = parseInt(i.LosInfo, 10);    // 1 = loss of signal
        if ('RegStatus' in i) result.reg_status = parseInt(i.RegStatus, 10);  // 5 = operational (O5)
    });

    // --- Internet (WAN) -------------------------------------------------------
    page('ethWanStatus', ['wan_internetstatus_lua.lua&TypeUplink=2&pageType=1'])[0].forEach(function (i) {
        if (i.StrServList && i.StrServList.indexOf('INTERNET') !== -1) {
            result.internet_status = i.ConnStatus;            // "Connected" when up
            result.internet_uptime = parseInt(i.UpTime, 10);  // seconds
        }
    });

    // --- Router CPU, memory, uptime ------------------------------------------
    page('statusMgr', ['devmgr_statusmgr_lua.lua'])[0].forEach(function (i) {
        if ('CpuUsage1' in i) {
            var cores = [1, 2, 3, 4].map(function (n) { return parseInt(i['CpuUsage' + n], 10); });
            result.cpu = cores.reduce(function (a, b) { return a + b; }, 0) / cores.length;
            result.mem = parseInt(i.MemUsage, 10);
        }
        if ('PowerOnTime' in i) result.uptime = parseInt(i.PowerOnTime, 10);
    });

    // --- LAN ports, Wi-Fi clients, connected devices (all on one page) -------
    var local = page('localNetStatus', [
        'status_lan_info_lua.lua',
        'wlan_client_stat_lua.lua',
        'accessdev_landevs_lua.lua',
        'wlan_wlanstatus_lua.lua'
    ]);

    result.lan = {};
    local[0].forEach(function (i) {
        var m = (i._InstID || '').match(/IF(\d+)$/);   // DEV.ETH.IF3 -> lan3
        if (!m) return;
        result.lan['lan' + m[1]] = {
            status:     parseInt(i.Status, 10),
            speed:      parseInt(i.Speed, 10),
            in_bytes:   parseFloat(i.InBytes),    // received by the router from the device
            out_bytes:  parseFloat(i.OutBytes),   // sent by the router to the device
            in_errors:  parseInt(i.InError, 10),
            out_errors: parseInt(i.OutError, 10)
        };
    });

    result.wifi_clients = local[1].length;
    result.lan_devices  = local[2].length;

    // Weakest Wi-Fi signal among connected clients (RSSI in dBm, closer to 0 = stronger)
    var rssi = local[1]
        .map(function (c) { return parseInt(c.RSSI, 10); })
        .filter(function (n) { return !isNaN(n); });
    if (rssi.length) result.wifi_rssi_min = Math.min.apply(null, rssi);

    // Wi-Fi traffic per enabled network (SSID1 = 2.4 GHz, SSID5 = 5 GHz on this router).
    // The router lists each network twice: one block with its settings (Alias, Enable),
    // a later block with its byte counters. Both share the same _InstID, so merge them.
    var ap = {};
    local[3].forEach(function (i) {
        if (!i._InstID) return;
        ap[i._InstID] = ap[i._InstID] || {};
        for (var k in i) ap[i._InstID][k] = i[k];
    });
    result.wifi = {};
    for (var id in ap) {
        var a = ap[id];
        if (a.Enable !== '1' || !a.Alias || a.TotalBytesSent === undefined) continue;
        result.wifi[a.Alias.toLowerCase()] = {
            ssid:     a.ESSID,
            rx_bytes: parseFloat(a.TotalBytesReceived),   // received by the router from Wi-Fi devices
            tx_bytes: parseFloat(a.TotalBytesSent)        // sent by the router to Wi-Fi devices
        };
    }
}
finally {
    if (loggedIn) {
        try { call('POST', '/?_type=loginData&_tag=logout_entry', 'IF_LogOff=1'); } catch (e) {}
    }
}

return JSON.stringify(result);