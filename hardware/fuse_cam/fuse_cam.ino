#include "esp_camera.h"
#include "fb_gfx.h"
#include "esp_http_server.h"
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>

static const char *WIFI_SSID = "BALANSAG";
static const char *WIFI_PASS = "PLDTWIFIwFF9n";

static const char *FB_API_KEY = "AIzaSyC96yxtivbIFBK1Vm1wSydR8Kn6-npkgZA";
static const char *FB_DB_URL = "https://spendwise-dec03-default-rtdb.firebaseio.com";
static const char *FB_BUCKET = "spendwise-dec03.firebasestorage.app";

static const char *NODE_EMAIL = "node-z01@fuse.local";
static const char *NODE_PASSWORD = "123456";

static const char *ZONE_ID = "Z-01";

static const uint32_t HTTP_TIMEOUT_MS = 8000;
static const uint32_t DETECT_MS = 200;
static const uint32_t STREAM_GAP_MS = 60;

static const int FLAME_R_MIN = 150;
static const int FLAME_RG_DIFF = 30;
static const int FLAME_GB_DIFF = 15;
static const float FLAME_PIXEL_RATIO = 0.020f;
static const int FLAME_CONFIRM = 3;

#define PWDN_GPIO_NUM 32
#define RESET_GPIO_NUM -1
#define XCLK_GPIO_NUM 0
#define SIOD_GPIO_NUM 26
#define SIOC_GPIO_NUM 27
#define Y9_GPIO_NUM 35
#define Y8_GPIO_NUM 34
#define Y7_GPIO_NUM 39
#define Y6_GPIO_NUM 36
#define Y5_GPIO_NUM 21
#define Y4_GPIO_NUM 19
#define Y3_GPIO_NUM 18
#define Y2_GPIO_NUM 5
#define VSYNC_GPIO_NUM 25
#define HREF_GPIO_NUM 23
#define PCLK_GPIO_NUM 22

WiFiClientSecure tls;

String idToken = "";
String refreshToken = "";
uint32_t tokenExpiresAt = 0;

SemaphoreHandle_t frameLock = NULL;
uint8_t *shareJpg = NULL;
size_t shareLen = 0;

uint8_t *upJpg = NULL;
size_t upLen = 0;

volatile bool flameNow = false;
volatile bool cloudDirty = false;

httpd_handle_t camServer = NULL;

static String jsonStr(const String &src, const char *key) {
  String pat = String("\"") + key + "\"";
  int i = src.indexOf(pat);
  if (i < 0) return "";
  i += pat.length();
  while (i < (int)src.length() && (src[i] == ' ' || src[i] == ':')) i++;
  if (i >= (int)src.length() || src[i] != '"') return "";
  i++;
  int j = src.indexOf('"', i);
  if (j < 0) return "";
  return src.substring(i, j);
}

static long jsonNum(const String &src, const char *key, long dflt) {
  String pat = String("\"") + key + "\"";
  int i = src.indexOf(pat);
  if (i < 0) return dflt;
  i += pat.length();
  while (i < (int)src.length() && (src[i] == ' ' || src[i] == ':')) i++;
  while (i < (int)src.length() && (src[i] == ' ' || src[i] == '"')) i++;
  int j = i;
  while (j < (int)src.length() && (isdigit(src[j]) || src[j] == '-' || src[j] == '.')) j++;
  if (j == i) return dflt;
  return src.substring(i, j).toInt();
}

static bool fbSignIn() {
  HTTPClient http;
  String url = String("https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=") + FB_API_KEY;
  if (!http.begin(tls, url)) return false;
  http.setTimeout(HTTP_TIMEOUT_MS);
  http.addHeader("Content-Type", "application/json");
  String body = String("{\"email\":\"") + NODE_EMAIL +
                "\",\"password\":\"" + NODE_PASSWORD +
                "\",\"returnSecureToken\":true}";
  int code = http.POST(body);
  String res = http.getString();
  http.end();

  if (code != 200) {
    Serial.printf("FUSE-CAM: sign-in failed %d %s\n", code, res.c_str());
    return false;
  }
  idToken = jsonStr(res, "idToken");
  refreshToken = jsonStr(res, "refreshToken");
  long ttl = jsonNum(res, "expiresIn", 3600);
  tokenExpiresAt = millis() + (uint32_t)((ttl > 600 ? ttl - 300 : ttl / 2) * 1000UL);
  if (!idToken.length()) {
    Serial.println("FUSE-CAM: sign-in ok but no token parsed");
    return false;
  }
  Serial.printf("FUSE-CAM: signed in, token %d chars\n", idToken.length());
  return true;
}

static bool fbRefresh() {
  if (!refreshToken.length()) return fbSignIn();
  HTTPClient http;
  String url = String("https://securetoken.googleapis.com/v1/token?key=") + FB_API_KEY;
  if (!http.begin(tls, url)) return false;
  http.setTimeout(HTTP_TIMEOUT_MS);
  http.addHeader("Content-Type", "application/x-www-form-urlencoded");
  int code = http.POST(String("grant_type=refresh_token&refresh_token=") + refreshToken);
  String res = http.getString();
  http.end();

  if (code != 200) return fbSignIn();
  idToken = jsonStr(res, "id_token");
  refreshToken = jsonStr(res, "refresh_token");
  long ttl = jsonNum(res, "expires_in", 3600);
  tokenExpiresAt = millis() + (uint32_t)((ttl > 600 ? ttl - 300 : ttl / 2) * 1000UL);
  return idToken.length() > 0;
}

static bool ensureToken() {
  if (WiFi.status() != WL_CONNECTED) return false;
  if (!idToken.length()) return fbSignIn();
  if ((int32_t)(millis() - tokenExpiresAt) >= 0) return fbRefresh();
  return true;
}

static bool rtdbPatch(const String &path, const String &json) {
  if (!ensureToken()) return false;
  HTTPClient http;
  String url = String(FB_DB_URL) + path + ".json?auth=" + idToken;
  if (!http.begin(tls, url)) return false;
  http.setTimeout(HTTP_TIMEOUT_MS);
  http.addHeader("Content-Type", "application/json");
  int code = http.sendRequest("PATCH", (uint8_t *)json.c_str(), json.length());
  if (code != 200) Serial.printf("FUSE-CAM: PATCH %s -> %d\n", path.c_str(), code);
  http.end();
  if (code == 401) idToken = "";
  return code == 200;
}

static String encodePath(const String &s) {
  String out = "";
  for (size_t i = 0; i < s.length(); i++) {
    char c = s[i];
    if (c == '/') out += "%2F";
    else out += c;
  }
  return out;
}

static bool storageUpload(const uint8_t *buf, size_t len, String &urlOut) {
  if (!ensureToken()) return false;
  String object = encodePath(String("frames/") + ZONE_ID + "/live.jpg");
  HTTPClient http;
  String url = String("https://firebasestorage.googleapis.com/v0/b/") + FB_BUCKET +
               "/o?uploadType=media&name=" + object;
  if (!http.begin(tls, url)) return false;
  http.setTimeout(HTTP_TIMEOUT_MS);
  http.addHeader("Content-Type", "image/jpeg");
  http.addHeader("Authorization", String("Firebase ") + idToken);
  int code = http.POST((uint8_t *)buf, len);
  String res = http.getString();
  http.end();
  if (code == 401) idToken = "";
  if (code != 200) {
    Serial.printf("FUSE-CAM: upload -> %d %s\n", code, res.c_str());
    return false;
  }
  String tok = jsonStr(res, "downloadTokens");
  if (!tok.length()) return false;
  urlOut = String("https://firebasestorage.googleapis.com/v0/b/") + FB_BUCKET +
           "/o/" + object + "?alt=media&token=" + tok;
  return true;
}

static bool detectFlame(camera_fb_t *fb) {
  if (!fb || fb->format != PIXFORMAT_RGB565) return false;
  size_t px = (size_t)fb->width * fb->height;
  uint8_t *b = fb->buf;
  uint32_t hits = 0;
  for (size_t i = 0; i < px; i++) {
    uint16_t p = ((uint16_t)b[i * 2] << 8) | b[i * 2 + 1];
    int r = ((p >> 11) & 0x1F) << 3;
    int g = ((p >> 5) & 0x3F) << 2;
    int bl = (p & 0x1F) << 3;
    if (r >= FLAME_R_MIN && (r - g) >= FLAME_RG_DIFF && (g - bl) >= FLAME_GB_DIFF) hits++;
  }
  return hits > (uint32_t)(px * FLAME_PIXEL_RATIO);
}

static void drawVerdict(camera_fb_t *fb, bool flame) {
  fb_data_t rfb;
  rfb.width = fb->width;
  rfb.height = fb->height;
  rfb.data = fb->buf;
  rfb.bytes_per_pixel = 2;
  rfb.format = FB_RGB565;
  fb_gfx_fillRect(&rfb, 0, 0, fb->width, 16, flame ? 0x0000FF : 0x00FF00);
  fb_gfx_print(&rfb, 6, 4, 0x000000, flame ? "FIRE DETECTED" : "SAFE");
}

static const char *STREAM_CT = "multipart/x-mixed-replace;boundary=fusecam";
static const char *STREAM_BOUNDARY = "\r\n--fusecam\r\n";
static const char *STREAM_PART = "Content-Type: image/jpeg\r\nContent-Length: %u\r\n\r\n";

static esp_err_t streamHandler(httpd_req_t *req) {
  esp_err_t res = httpd_resp_set_type(req, STREAM_CT);
  if (res != ESP_OK) return res;
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  char part[64];

  while (true) {
    uint8_t *copy = NULL;
    size_t len = 0;
    if (xSemaphoreTake(frameLock, pdMS_TO_TICKS(1000)) == pdTRUE) {
      if (shareJpg && shareLen) {
        copy = (uint8_t *)ps_malloc(shareLen);
        if (copy) {
          memcpy(copy, shareJpg, shareLen);
          len = shareLen;
        }
      }
      xSemaphoreGive(frameLock);
    }
    if (!copy) {
      vTaskDelay(pdMS_TO_TICKS(50));
      continue;
    }
    size_t hlen = snprintf(part, sizeof(part), STREAM_PART, (unsigned)len);
    res = httpd_resp_send_chunk(req, STREAM_BOUNDARY, strlen(STREAM_BOUNDARY));
    if (res == ESP_OK) res = httpd_resp_send_chunk(req, part, hlen);
    if (res == ESP_OK) res = httpd_resp_send_chunk(req, (const char *)copy, len);
    free(copy);
    if (res != ESP_OK) break;
    vTaskDelay(pdMS_TO_TICKS(STREAM_GAP_MS));
  }
  return res;
}

static void startCamServer() {
  httpd_config_t config = HTTPD_DEFAULT_CONFIG();
  config.server_port = 80;
  config.ctrl_port = 32768;
  config.stack_size = 8192;
  config.core_id = 1;
  config.lru_purge_enable = true;

  httpd_uri_t streamUri = {
    .uri = "/stream",
    .method = HTTP_GET,
    .handler = streamHandler,
    .user_ctx = NULL
  };

  if (httpd_start(&camServer, &config) == ESP_OK) {
    httpd_register_uri_handler(camServer, &streamUri);
    Serial.println("FUSE-CAM: stream server on /stream");
  } else {
    Serial.println("FUSE-CAM: stream server failed to start");
  }
}

static void visionTask(void *arg) {
  bool stable = false;
  int agree = 0;

  while (true) {
    camera_fb_t *fb = esp_camera_fb_get();
    if (!fb) {
      vTaskDelay(pdMS_TO_TICKS(DETECT_MS));
      continue;
    }

    bool raw = detectFlame(fb);
    if (raw == stable) {
      agree = 0;
    } else if (++agree >= FLAME_CONFIRM) {
      stable = raw;
      agree = 0;
    }
    drawVerdict(fb, stable);

    uint8_t *jpg = NULL;
    size_t jlen = 0;
    bool encoded = frame2jpg(fb, 80, &jpg, &jlen);
    esp_camera_fb_return(fb);

    if (encoded) {
      if (xSemaphoreTake(frameLock, pdMS_TO_TICKS(200)) == pdTRUE) {
        if (shareJpg) free(shareJpg);
        shareJpg = jpg;
        shareLen = jlen;
        if (stable != flameNow) {
          if (upJpg) free(upJpg);
          upJpg = (uint8_t *)ps_malloc(jlen);
          if (upJpg) {
            memcpy(upJpg, jpg, jlen);
            upLen = jlen;
          }
        }
        xSemaphoreGive(frameLock);
      } else {
        free(jpg);
      }
    }

    if (stable != flameNow) {
      flameNow = stable;
      cloudDirty = true;
      Serial.printf("FUSE-CAM: verdict %s\n", stable ? "FIRE DETECTED" : "SAFE");
    }

    vTaskDelay(pdMS_TO_TICKS(DETECT_MS));
  }
}

static void cloudTask(void *arg) {
  String lastIp = "";

  while (true) {
    if (WiFi.status() != WL_CONNECTED) {
      vTaskDelay(pdMS_TO_TICKS(1000));
      continue;
    }

    String ip = WiFi.localIP().toString();
    if (ip != lastIp) {
      String json = String("{\"camIp\":\"") + ip + "\"}";
      if (rtdbPatch(String("/zones/") + ZONE_ID, json)) lastIp = ip;
    }

    if (cloudDirty) {
      cloudDirty = false;
      bool f = flameNow;
      rtdbPatch(String("/zones/") + ZONE_ID,
                String("{\"r/flame\":") + (f ? "true" : "false") + "}");

      uint8_t *buf = NULL;
      size_t len = 0;
      if (xSemaphoreTake(frameLock, pdMS_TO_TICKS(500)) == pdTRUE) {
        buf = upJpg;
        len = upLen;
        upJpg = NULL;
        upLen = 0;
        xSemaphoreGive(frameLock);
      }
      if (buf) {
        String url;
        if (storageUpload(buf, len, url)) {
          rtdbPatch(String("/zones/") + ZONE_ID,
                    String("{\"frame\":\"") + url + "\"}");
        }
        free(buf);
      }
    }

    vTaskDelay(pdMS_TO_TICKS(200));
  }
}

void setup() {
  Serial.begin(115200);
  delay(200);

  camera_config_t cfg;
  cfg.ledc_channel = LEDC_CHANNEL_0;
  cfg.ledc_timer = LEDC_TIMER_0;
  cfg.pin_d0 = Y2_GPIO_NUM;
  cfg.pin_d1 = Y3_GPIO_NUM;
  cfg.pin_d2 = Y4_GPIO_NUM;
  cfg.pin_d3 = Y5_GPIO_NUM;
  cfg.pin_d4 = Y6_GPIO_NUM;
  cfg.pin_d5 = Y7_GPIO_NUM;
  cfg.pin_d6 = Y8_GPIO_NUM;
  cfg.pin_d7 = Y9_GPIO_NUM;
  cfg.pin_xclk = XCLK_GPIO_NUM;
  cfg.pin_pclk = PCLK_GPIO_NUM;
  cfg.pin_vsync = VSYNC_GPIO_NUM;
  cfg.pin_href = HREF_GPIO_NUM;
  cfg.pin_sccb_sda = SIOD_GPIO_NUM;
  cfg.pin_sccb_scl = SIOC_GPIO_NUM;
  cfg.pin_pwdn = PWDN_GPIO_NUM;
  cfg.pin_reset = RESET_GPIO_NUM;
  cfg.xclk_freq_hz = 20000000;
  cfg.pixel_format = PIXFORMAT_RGB565;
  cfg.frame_size = FRAMESIZE_QVGA;
  cfg.jpeg_quality = 12;
  cfg.fb_count = 2;
  cfg.fb_location = CAMERA_FB_IN_PSRAM;
  cfg.grab_mode = CAMERA_GRAB_LATEST;

  esp_err_t err = esp_camera_init(&cfg);
  if (err != ESP_OK) {
    Serial.printf("FUSE-CAM: camera init failed 0x%x\n", err);
    delay(3000);
    ESP.restart();
  }

  sensor_t *s = esp_camera_sensor_get();
  if (s) {
    s->set_vflip(s, 0);
    s->set_hmirror(s, 0);
    s->set_whitebal(s, 1);
    s->set_awb_gain(s, 1);
  }

  frameLock = xSemaphoreCreateMutex();

  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.print("FUSE-CAM: wifi");
  uint32_t t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < 20000) {
    delay(400);
    Serial.print(".");
  }
  Serial.println();

  tls.setInsecure();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println(WiFi.localIP());
  }

  startCamServer();

  xTaskCreatePinnedToCore(visionTask, "vision", 8192, NULL, 2, NULL, 1);
  xTaskCreatePinnedToCore(cloudTask, "cloud", 16384, NULL, 1, NULL, 0);

  Serial.printf("FUSE-CAM: up, zone=%s\n", ZONE_ID);
}

void loop() {
  vTaskDelay(pdMS_TO_TICKS(1000));
}
