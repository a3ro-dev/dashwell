package dev.a3ro.tumblrnew;

import android.app.Activity;
import android.app.Dialog;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
import android.webkit.CookieManager;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.window.OnBackInvokedDispatcher;

import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Pattern;

/**
 * Dashwell for Android: tumblr.com in a WebView with the extension's scripts injected,
 * ads blocked at the network layer, and the extension popup reused as a settings sheet.
 */
public class MainActivity extends Activity {
    private static final String HOME = "https://www.tumblr.com/";
    private static final String TUMBLR_ORIGIN = "https://www.tumblr.com";
    private static final String ASSETS_ORIGIN = "https://appassets.androidplatform.net";
    private static final Pattern RSS_URL = Pattern.compile("^https://[\\w-]+\\.tumblr\\.com/rss$");
    private static final Pattern STORAGE_KEY = Pattern.compile("^[A-Za-z0-9_-]{1,64}$");
    private static final int FILE_REQUEST = 42;
    // Public half of the OTA signing key (scripts/ota.mjs holds the private half). OTA_FILES must match that script.
    private static final String OTA_KEY = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEAoIW8FVb2NZcmjPMEGGucY20lesyWDLibfIWy7sefYaujR6MC6zQtQ/DtiPkxISs3Zh0nU9waWFoJkdEprOrYg==";
    private static final List<String> OTA_FILES = java.util.Arrays.asList("feed.js", "content.js", "content.css", "cosmetic.css");
    private static final int MAX_RSS_BYTES = 2 << 20;

    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final ExecutorService net = Executors.newFixedThreadPool(4);
    private volatile Set<String> blockedDomains = new HashSet<>();
    private volatile List<Pattern> blockedPaths = new ArrayList<>();
    private File store;
    private WebView web;
    private WebView sheetWeb;
    private Dialog sheet;
    private ValueCallback<Uri[]> fileCallback;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        store = new File(getFilesDir(), "storage");
        store.mkdirs();
        io.execute(this::loadAdRules);
        WebView.setWebContentsDebuggingEnabled((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#0d0d0d")); // Tumblr header colour, so the status bar strip blends in
        // targetSdk 35+ draws edge-to-edge: keep content clear of the status and navigation bars.
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets i = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime());
                v.setPadding(i.left, i.top, i.right, i.bottom);
            } else {
                v.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                        insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            }
            return insets;
        });

        web = newWebView();
        setUpDashboard(web);
        root.addView(web, new FrameLayout.LayoutParams(-1, -1));

        setContentView(root);

        if (Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                    OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::goBack);
        }

        net.execute(this::checkForUpdate);

        Uri link = getIntent().getData();
        web.loadUrl(link != null && "www.tumblr.com".equals(link.getHost()) ? link.toString() : HOME);
    }

    // WebView writes cookies to disk lazily; flush whenever we leave the foreground so a
    // fresh login survives the app being killed (and every update installed over it).
    @Override
    protected void onPause() {
        super.onPause();
        CookieManager.getInstance().flush();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        Uri link = intent.getData();
        if (link != null && "www.tumblr.com".equals(link.getHost())) web.loadUrl(link.toString());
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        goBack();
    }

    private void goBack() {
        if (web.canGoBack()) web.goBack();
        else finish();
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    private WebView newWebView() {
        WebView w = new WebView(this);
        WebSettings s = w.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(w, true);
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            Set<String> origins = new HashSet<>();
            origins.add(TUMBLR_ORIGIN);
            origins.add(ASSETS_ORIGIN);
            WebViewCompat.addWebMessageListener(w, "TumblrNewNative", origins, this::onBridgeMessage);
        }
        return w;
    }

    // ---- dashboard ----

    private void setUpDashboard(WebView w) {
        String script = "(()=>{" + asset("shim.js") + "\n" + asset("feed.js") + "\n"
                + "{const s=document.createElement('style');s.textContent=" + JSONObject.quote(asset("cosmetic.css") + "\n" + asset("content.css"))
                + ";(document.head||document.documentElement).appendChild(s);}\n"
                + asset("content.js") + "\n})();";
        boolean docStart = WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT);
        if (docStart) {
            Set<String> origins = new HashSet<>();
            origins.add(TUMBLR_ORIGIN);
            WebViewCompat.addDocumentStartJavaScript(w, script, origins);
        }
        w.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                return isAd(req.getUrl()) ? empty() : null;
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                String scheme = u.getScheme();
                // tumblr://, intent:// and market:// try to bounce you into the official app: ignore them.
                if (!"https".equals(scheme) && !"http".equals(scheme)) return true;
                String host = u.getHost();
                if (host != null && (host.equals("tumblr.com") || host.endsWith(".tumblr.com"))) return false;
                if (host != null && host.equals("play.google.com")) return true;
                if (host != null && (host.equals("accounts.google.com") || host.equals("appleid.apple.com"))) {
                    explainSocialLogin(host.contains("google") ? "Google" : "Apple");
                    return true;
                }
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, req.getUrl())); // other sites open in the browser
                } catch (Exception ignored) {
                }
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                // Old WebViews without document-start scripts: inject once the page loads.
                if (!docStart && url.startsWith(TUMBLR_ORIGIN)) view.evaluateJavascript("if(!window.__tn){window.__tn=1;" + script + "}", null);
            }
        });
        w.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> cb, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = cb;
                try {
                    startActivityForResult(params.createIntent(), FILE_REQUEST);
                } catch (Exception e) {
                    fileCallback = null;
                    return false;
                }
                return true;
            }
        });
    }

    private String appVersion() {
        try {
            return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (Exception e) {
            return "0";
        }
    }

    // Updates: at most once a day, ask GitHub for the latest release and offer its APK.
    private void checkForUpdate() {
        android.content.SharedPreferences prefs = getSharedPreferences("updates", MODE_PRIVATE);
        long now = System.currentTimeMillis();
        if (now - prefs.getLong("checked", 0) < 24L * 3600 * 1000) return;
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL("https://api.github.com/repos/a3ro-dev/dashwell/releases/latest").openConnection();
            c.setConnectTimeout(10000);
            c.setReadTimeout(10000);
            c.setRequestProperty("Accept", "application/vnd.github+json");
            if (c.getResponseCode() != 200) return;
            String body;
            try (InputStream in = c.getInputStream()) {
                ByteArrayOutputStream buf = new ByteArrayOutputStream();
                byte[] chunk = new byte[16384];
                int n;
                while ((n = in.read(chunk)) > 0) buf.write(chunk, 0, n);
                body = buf.toString("UTF-8");
            }
            prefs.edit().putLong("checked", now).apply();
            JSONObject rel = new JSONObject(body);
            String latest = rel.getString("tag_name").replaceFirst("^v", "");
            if (!isNewer(latest, appVersion())) return;
            if (applyOta(rel, latest, prefs)) return; // content-only release: applied silently on next launch
            JSONArray assets = rel.optJSONArray("assets");
            String apk = null;
            for (int i = 0; assets != null && i < assets.length(); i++) {
                JSONObject a = assets.getJSONObject(i);
                if (a.getString("name").endsWith(".apk")) apk = a.getString("browser_download_url");
            }
            if (apk == null) return;
            String url = apk;
            runOnUiThread(() -> new android.app.AlertDialog.Builder(this)
                    .setTitle("Version " + latest + " is out")
                    .setMessage("Download the update now? Your browser downloads it; tap the download to install over this version. Your settings stay.")
                    .setPositiveButton("Download", (d, w) -> startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))))
                    .setNegativeButton("Later", null)
                    .show());
        } catch (Exception ignored) {
        } finally {
            if (c != null) c.disconnect();
        }
    }

    // Over-the-air content: the release's signed ota.json carries the page scripts and CSS. Anything that
    // fails (download, signature, version, missing file) returns false and the APK dialog takes over.
    private boolean applyOta(JSONObject rel, String latest, android.content.SharedPreferences prefs) {
        String jsonUrl = null, sigUrl = null;
        JSONArray assets = rel.optJSONArray("assets");
        for (int i = 0; assets != null && i < assets.length(); i++) {
            JSONObject a = assets.optJSONObject(i);
            if (a == null) continue;
            if (a.optString("name").equals("ota.json")) jsonUrl = a.optString("browser_download_url");
            if (a.optString("name").equals("ota.json.sig")) sigUrl = a.optString("browser_download_url");
        }
        if (jsonUrl == null || sigUrl == null) return false;
        try {
            String have = prefs.getString("ota", null);
            if (latest.equals(have)) return true;
            byte[] body = download(jsonUrl), sig = download(sigUrl);
            java.security.Signature s = java.security.Signature.getInstance("SHA256withECDSA");
            s.initVerify(java.security.KeyFactory.getInstance("EC").generatePublic(
                    new java.security.spec.X509EncodedKeySpec(android.util.Base64.decode(OTA_KEY, android.util.Base64.DEFAULT))));
            s.update(body);
            if (!s.verify(sig)) return false;
            JSONObject m = new JSONObject(new String(body, StandardCharsets.UTF_8));
            // version must be the release's own (no replaying an older signed file); minApp = needs a newer APK
            if (!latest.equals(m.getString("version")) || isNewer(m.getString("minApp"), appVersion())) return false;
            JSONObject files = m.getJSONObject("files");
            File dir = new File(getFilesDir(), "ota-" + latest);
            dir.mkdirs();
            for (String n : OTA_FILES) Files.write(new File(dir, n).toPath(), files.getString(n).getBytes(StandardCharsets.UTF_8));
            prefs.edit().putString("ota", latest).apply();
            File[] old = getFilesDir().listFiles((d, n) -> n.startsWith("ota-") && !n.equals("ota-" + latest));
            if (old != null) for (File d : old) {
                File[] fs = d.listFiles();
                if (fs != null) for (File f : fs) f.delete();
                d.delete();
            }
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    private byte[] download(String url) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        try {
            c.setConnectTimeout(10000);
            c.setReadTimeout(20000);
            if (c.getResponseCode() != 200) throw new IOException("http " + c.getResponseCode());
            try (InputStream in = c.getInputStream()) {
                ByteArrayOutputStream buf = new ByteArrayOutputStream();
                byte[] chunk = new byte[16384];
                int n;
                while ((n = in.read(chunk)) > 0) {
                    buf.write(chunk, 0, n);
                    if (buf.size() > 4 << 20) throw new IOException("too big");
                }
                return buf.toByteArray();
            }
        } finally {
            c.disconnect();
        }
    }

    static boolean isNewer(String a, String b) {
        String[] x = a.split("[.]"), y = b.split("[.]");
        for (int i = 0; i < 3; i++) {
            int p = i < x.length ? parse(x[i]) : 0, q = i < y.length ? parse(y[i]) : 0;
            if (p != q) return p > q;
        }
        return false;
    }

    private static int parse(String s) {
        try {
            return Integer.parseInt(s.replaceAll("[^0-9].*$", ""));
        } catch (Exception e) {
            return 0;
        }
    }

    // Google and Apple refuse sign-in inside embedded browsers, and sending it out to Chrome
    // lands the session in Chrome (or the official app), never here. Say so instead of bouncing.
    private void explainSocialLogin(String provider) {
        new android.app.AlertDialog.Builder(this)
                .setTitle(provider + " sign-in doesn't work in apps")
                .setMessage(provider + " blocks sign-in inside other apps. Log in with your email and password instead.\n\n"
                        + "No password yet? On the login screen tap \"Forgot password\" and enter the email on your "
                        + provider + " account. Tumblr emails you a link to set one.")
                .setPositiveButton("OK", null)
                .show();
    }

    @Override
    protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request == FILE_REQUEST && fileCallback != null) {
            fileCallback.onReceiveValue(pickedUris(result, data));
            fileCallback = null;
        }
    }

    // WebChromeClient.FileChooserParams.parseResult returned null for this phone's photo picker (a ClipData
    // result), so the page never got the file. Read the result ourselves.
    private static Uri[] pickedUris(int result, Intent data) {
        if (result != RESULT_OK || data == null) return null;
        android.content.ClipData clip = data.getClipData();
        if (clip != null) {
            List<Uri> out = new ArrayList<>();
            for (int i = 0; i < clip.getItemCount(); i++) if (clip.getItemAt(i).getUri() != null) out.add(clip.getItemAt(i).getUri());
            if (!out.isEmpty()) return out.toArray(new Uri[0]);
        }
        return data.getData() != null ? new Uri[] {data.getData()} : WebChromeClient.FileChooserParams.parseResult(result, data);
    }

    // ---- settings sheet (the extension popup) ----

    private void openSheet() {
        if (sheet == null) {
            WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                    .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this)).build();
            sheetWeb = newWebView();
            if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
                Set<String> origins = new HashSet<>();
                origins.add(ASSETS_ORIGIN);
                WebViewCompat.addDocumentStartJavaScript(sheetWeb, "globalThis.__tnAppVersion=" + JSONObject.quote(appVersion()) + ";\n" + asset("shim.js")
                        + "\ndocument.addEventListener('DOMContentLoaded',()=>{const s=document.createElement('style');"
                        + "s.textContent='body{width:auto!important;padding:16px 18px 32px}';document.head.append(s);});", origins);
            }
            String background = asset("background.js");
            sheetWeb.setWebViewClient(new WebViewClient() {
                @Override
                public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                    return loader.shouldInterceptRequest(req.getUrl());
                }

                @Override
                public void onPageFinished(WebView view, String url) {
                    // background.js provides the RSS catch-up; run a check every time the sheet loads.
                    view.evaluateJavascript(background + "\ncheck();", null);
                }
            });
            sheetWeb.setWebChromeClient(new WebChromeClient()); // enables confirm() for "Reset"

            sheet = new Dialog(this);
            sheet.requestWindowFeature(Window.FEATURE_NO_TITLE);
            sheet.setContentView(sheetWeb);
            sheetWeb.loadUrl(ASSETS_ORIGIN + "/assets/popup.html");
        } else {
            sheetWeb.evaluateJavascript("typeof check==='function'&&check();", null);
        }
        sheet.show();
        Window win = sheet.getWindow();
        if (win != null) {
            win.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, (int) (getResources().getDisplayMetrics().heightPixels * 0.85));
            win.setGravity(Gravity.BOTTOM);
            win.setBackgroundDrawableResource(android.R.color.transparent);
        }
    }

    // ---- bridge: storage, RSS, badge ----

    private void onBridgeMessage(WebView view, WebMessageCompat message, Uri origin, boolean isMainFrame, JavaScriptReplyProxy reply) {
        if (!isMainFrame) return;
        try {
            JSONObject m = new JSONObject(message.getData());
            int id = m.getInt("id");
            String op = m.getString("op");
            switch (op) {
                case "get":
                case "set":
                case "remove": {
                    String key = m.getString("key");
                    if (!STORAGE_KEY.matcher(key).matches()) return; // keys become file names
                    String value = m.optString("value", null);
                    io.execute(() -> {
                        Object result = storage(op, key, value);
                        respond(reply, id, result);
                        if (!op.equals("get")) runOnUiThread(() -> broadcast(key, op.equals("set") ? value : null));
                    });
                    break;
                }
                case "rss": {
                    String url = m.getString("url");
                    if (!RSS_URL.matcher(url).matches()) return;
                    net.execute(() -> respond(reply, id, fetchRss(url)));
                    break;
                }
                case "badge": // the page shows the count on its top-bar icon itself
                    respond(reply, id, null);
                    break;
                case "open": {
                    Uri u = Uri.parse(m.getString("url"));
                    String h = u.getHost() == null ? "" : u.getHost();
                    if (!"https".equals(u.getScheme())) return;
                    if (h.equals("tumblr.com") || h.endsWith(".tumblr.com")) {
                        if (sheet != null) sheet.dismiss();
                        web.loadUrl(u.toString()); // a favorite's post: open it right here
                    } else if (h.equals("github.com") || h.endsWith(".githubusercontent.com") || h.equals("a3ro.dev")) {
                        startActivity(new Intent(Intent.ACTION_VIEW, u)); // update download
                    }
                    respond(reply, id, null);
                    break;
                }
                case "sheet":
                    if (view == web) openSheet();
                    respond(reply, id, null);
                    break;
            }
        } catch (Exception ignored) {
        }
    }

    private Object storage(String op, String key, String value) {
        File f = new File(store, key + ".json");
        try {
            switch (op) {
                case "get":
                    return f.exists() ? new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8) : null;
                case "set":
                    File tmp = new File(store, key + ".tmp"); // write-then-rename so a crash can't truncate state
                    Files.write(tmp.toPath(), value.getBytes(StandardCharsets.UTF_8));
                    if (!tmp.renameTo(f)) {
                        f.delete();
                        tmp.renameTo(f);
                    }
                    return null;
                default:
                    f.delete();
                    return null;
            }
        } catch (IOException e) {
            return null;
        }
    }

    // Tell every screen about changes; the feed engine itself is skipped (large, only the dashboard writes it).
    private void broadcast(String key, String jsonValue) {
        if (key.equals("engine") && jsonValue != null) return;
        String js = "window.__tnStorageChanged&&__tnStorageChanged({" + JSONObject.quote(key) + ":{newValue:" + (jsonValue == null ? "undefined" : jsonValue) + "}})";
        web.evaluateJavascript(js, null);
        if (sheetWeb != null) sheetWeb.evaluateJavascript(js, null);
    }

    private void respond(JavaScriptReplyProxy reply, int id, Object result) {
        runOnUiThread(() -> {
            try {
                JSONObject r = new JSONObject();
                r.put("id", id);
                r.put("result", result == null ? JSONObject.NULL : result);
                reply.postMessage(r.toString());
            } catch (Exception ignored) {
            }
        });
    }

    private String fetchRss(String url) {
        JSONObject out = new JSONObject();
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(10000);
            c.setReadTimeout(10000);
            out.put("status", c.getResponseCode());
            try (InputStream in = c.getInputStream()) {
                ByteArrayOutputStream buf = new ByteArrayOutputStream();
                byte[] chunk = new byte[16384];
                int n;
                while ((n = in.read(chunk)) > 0 && buf.size() < MAX_RSS_BYTES) buf.write(chunk, 0, n);
                out.put("body", buf.toString("UTF-8"));
            }
        } catch (Exception e) {
            try {
                out.put("status", 599);
            } catch (Exception ignored) {
            }
        } finally {
            if (c != null) c.disconnect();
        }
        return out.toString();
    }

    // ---- ad blocking: the same rules/ads.json the extension uses ----

    private void loadAdRules() {
        try {
            JSONArray rules = new JSONArray(asset("rules/ads.json"));
            Set<String> domains = new HashSet<>();
            List<Pattern> paths = new ArrayList<>();
            for (int i = 0; i < rules.length(); i++) {
                JSONObject cond = rules.getJSONObject(i).getJSONObject("condition");
                JSONArray d = cond.optJSONArray("requestDomains");
                if (d != null) for (int j = 0; j < d.length(); j++) domains.add(d.getString(j));
                String filter = cond.optString("urlFilter", "");
                if (filter.startsWith("||")) paths.add(urlFilterToRegex(filter.substring(2)));
            }
            blockedDomains = domains;
            blockedPaths = paths;
        } catch (Exception ignored) {
        }
    }

    // DNR urlFilter "||host/path*x^" -> regex anchored at a host boundary.
    static Pattern urlFilterToRegex(String f) {
        StringBuilder re = new StringBuilder("^https?://([^/]*\\.)?");
        for (char ch : f.toCharArray()) {
            if (ch == '*') re.append(".*");
            else if (ch == '^') re.append("([/?:&=]|$)");
            else re.append(Pattern.quote(String.valueOf(ch)));
        }
        return Pattern.compile(re.toString());
    }

    private boolean isAd(Uri url) {
        String host = url.getHost();
        if (host == null) return false;
        for (String h = host; h.contains("."); h = h.substring(h.indexOf('.') + 1)) {
            if (blockedDomains.contains(h)) return true;
        }
        if (host.endsWith("tumblr.com")) {
            String s = url.toString();
            for (Pattern p : blockedPaths) if (p.matcher(s).find()) return true;
        }
        return false;
    }

    private static WebResourceResponse empty() {
        return new WebResourceResponse("text/plain", "utf-8", new ByteArrayInputStream(new byte[0]));
    }

    private String asset(String name) {
        // Over-the-air content (see applyOta) wins over the bundled copy, but only while it is newer than this APK.
        String ota = getSharedPreferences("updates", MODE_PRIVATE).getString("ota", null);
        if (ota != null && OTA_FILES.contains(name) && isNewer(ota, appVersion())) {
            try {
                return new String(Files.readAllBytes(new File(getFilesDir(), "ota-" + ota + "/" + name).toPath()), StandardCharsets.UTF_8);
            } catch (IOException ignored) { // fall through to the bundled copy
            }
        }
        try (InputStream in = getAssets().open(name)) {
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            byte[] chunk = new byte[16384];
            int n;
            while ((n = in.read(chunk)) > 0) buf.write(chunk, 0, n);
            return buf.toString("UTF-8");
        } catch (IOException e) {
            return "";
        }
    }
}
