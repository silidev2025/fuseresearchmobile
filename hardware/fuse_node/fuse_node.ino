#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#include <time.h>

struct Reading {
  float temp;
  float gas;
  float smoke;
  float co;
  bool flame;
};

static const char *WIFI_SSID = "BALANSAG";
static const char *WIFI_PASS = "PLDTWIFIwFF9n";

static const char *FB_API_KEY = "AIzaSyC96yxtivbIFBK1Vm1wSydR8Kn6-npkgZA";
static const char *FB_DB_URL = "https://spendwise-dec03-default-rtdb.firebaseio.com";
static const char *FB_PROJECT_ID = "spendwise-dec03";

static const char *NODE_EMAIL = "node-z01@fuse.local";
static const char *NODE_PASSWORD = "123456";

static const char *ZONE_ID = "Z-01";
static const char *ZONE_NAME = "Zone 1";
static const char *ZONE_FLOOR = "Ground";

#define PUBLISH_SMOKE 0
#define PUSH_EVENTS 0

static const float MQ2_ADC_SCALE = 1.0f;

#define MQ2_PIN 34
#define ONE_WIRE_BUS 4
#define FAN_PIN 26
#define VALVE_PIN 27
#define BUZZER_PIN 25

#define VALVE_CLOSE_LEVEL HIGH

static const uint32_t SAMPLE_MS = 500;
static const uint32_t HEARTBEAT_MS = 5000;
static const uint32_t OVERRIDE_POLL_MS = 4000;
static const uint32_t MQ2_WARMUP_MS = 60000;
static const uint32_t SILENCE_MS = 600000;
static const uint32_t HTTP_TIMEOUT_MS = 8000;
static const uint32_t CAM_FLAME_TTL_MS = 30000;
static const uint64_t WDT_TIMEOUT_US = 30000000ULL;

static const uint32_t RISE_MS[4] = {0, 3000, 5000, 2000};
static const uint32_t FALL_MS = 15000;

#define PWM_FREQ 5000
#define PWM_RES 8

#if ESP_ARDUINO_VERSION_MAJOR >= 3
#define FAN_PWM_BEGIN() ledcAttach(FAN_PIN, PWM_FREQ, PWM_RES)
#define FAN_PWM_WRITE(d) ledcWrite(FAN_PIN, (d))
#else
#define FAN_PWM_BEGIN()          \
  do {                           \
    ledcSetup(0, PWM_FREQ, PWM_RES); \
    ledcAttachPin(FAN_PIN, 0);   \
  } while (0)
#define FAN_PWM_WRITE(d) ledcWrite(0, (d))
#endif

hw_timer_t *wdt = NULL;

void IRAM_ATTR onWatchdog() {
  ets_printf("FUSE: watchdog fired, restarting\n");
  esp_restart();
}

static void wdtBegin() {
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  wdt = timerBegin(1000000);
  timerAttachInterrupt(wdt, &onWatchdog);
  timerAlarm(wdt, WDT_TIMEOUT_US, false, 0);
#else
  wdt = timerBegin(0, 80, true);
  timerAttachInterrupt(wdt, &onWatchdog, true);
  timerAlarmWrite(wdt, WDT_TIMEOUT_US, false);
  timerAlarmEnable(wdt);
#endif
}

static void wdtFeed() {
  if (wdt) timerWrite(wdt, 0);
}

static const float TH_TEMP[3] = {36, 48, 65};
static const float TH_GAS[3] = {1100, 1800, 2600};
static const float TH_SMOKE[3] = {5, 10, 18};
static const float TH_CO[3] = {50, 120, 300};

static const char *SEV[4] = {"NORMAL", "CAUTION", "WARNING", "CRITICAL"};

static int lvlOf(float v, const float th[3]) {
  int l = 0;
  for (int i = 0; i < 3; i++)
    if (v > th[i]) l = i + 1;
  return l;
}

static int classify(const Reading &r) {
  int Lsmoke = lvlOf(r.smoke, TH_SMOKE);
  int Lflame = r.flame ? 2 : 0;
  int Ltemp = lvlOf(r.temp, TH_TEMP);
  int Lgas = lvlOf(r.gas, TH_GAS);
  int Lco = lvlOf(r.co, TH_CO);

  int base = Lsmoke;
  if (Lflame > base) base = Lflame;
  if (Ltemp > base) base = Ltemp;
  if (Lgas > base) base = Lgas;
  if (Lco > base) base = Lco;

  int elev = (Lsmoke >= 1) + (Lflame >= 1) + (Ltemp >= 1) + (Lgas >= 1) + (Lco >= 1);

  int level;
  if (elev == 0) level = 0;
  else if (elev == 1) level = (base >= 3) ? 2 : 1;
  else level = min(3, base + 1);

  if (Lflame >= 2 && (Lsmoke >= 1 || Ltemp >= 1)) level = 3;
  if (elev >= 4) level = 3;
  return level;
}

static String readingSummary(const Reading &r) {
  String p = "";
  if (r.flame) p += "flame DETECTED";
  if (r.smoke > TH_SMOKE[0]) {
    if (p.length()) p += " \xc2\xb7 ";
    p += "smoke " + String(r.smoke, 1) + " %obs";
  }
  if (r.temp > TH_TEMP[0]) {
    if (p.length()) p += " \xc2\xb7 ";
    p += "temp " + String(r.temp, 1) + " C";
  }
  if (r.gas > TH_GAS[0]) {
    if (p.length()) p += " \xc2\xb7 ";
    p += "gas " + String((int)r.gas) + " ADC";
  }
  if (!p.length())
    p = "all sensors nominal \xc2\xb7 temp " + String(r.temp, 1) + " C \xc2\xb7 gas " + String((int)r.gas) + " ADC";
  return p;
}

OneWire oneWire(ONE_WIRE_BUS);
DallasTemperature dallas(&oneWire);
WiFiClientSecure tls;

String idToken = "";
String refreshToken = "";
uint32_t tokenExpiresAt = 0;

int committedLevel = 0;
int pendingLevel = 0;
uint32_t pendingSince = 0;
int publishedLevel = 0;

int ovFan = -1;
String ovValve = "";
bool silenced = false;
uint32_t silencedAt = 0;
int silencedAtLevel = 0;

bool camFlame = false;
uint32_t camFlameAt = 0;

float lastGoodTemp = 25.0f;
bool tempFault = false;
uint32_t bootAt = 0;
uint32_t lastSample = 0;
uint32_t lastBeat = 0;
uint32_t lastPoll = 0;

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

static bool timeReady() { return time(nullptr) > 1700000000; }

static uint64_t epochMs() {
  return (uint64_t)time(nullptr) * 1000ULL + (millis() % 1000);
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
  wdtFeed();

  if (code != 200) {
    Serial.printf("FUSE: sign-in failed %d %s\n", code, res.c_str());
    return false;
  }
  idToken = jsonStr(res, "idToken");
  refreshToken = jsonStr(res, "refreshToken");
  long ttl = jsonNum(res, "expiresIn", 3600);
  tokenExpiresAt = millis() + (uint32_t)((ttl > 600 ? ttl - 300 : ttl / 2) * 1000UL);
  if (!idToken.length()) {
    Serial.println("FUSE: sign-in ok but no token parsed");
    return false;
  }
  Serial.printf("FUSE: signed in, token %d chars\n", idToken.length());
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
  wdtFeed();

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
  if (code != 200) Serial.printf("FUSE: PATCH %s -> %d\n", path.c_str(), code);
  http.end();
  wdtFeed();
  if (code == 401) idToken = "";
  return code == 200;
}

static bool rtdbGet(const String &path, String &out) {
  if (!ensureToken()) return false;
  HTTPClient http;
  String url = String(FB_DB_URL) + path + ".json?auth=" + idToken;
  if (!http.begin(tls, url)) return false;
  http.setTimeout(HTTP_TIMEOUT_MS);
  int code = http.GET();
  out = (code == 200) ? http.getString() : String("");
  if (code != 200) Serial.printf("FUSE: GET %s -> %d\n", path.c_str(), code);
  http.end();
  wdtFeed();
  if (code == 401) idToken = "";
  return code == 200;
}

static void fsAddEvent(int from, int to, const Reading &r) {
#if PUSH_EVENTS
  if (!ensureToken() || !timeReady()) return;
  HTTPClient http;
  String url = String("https://firestore.googleapis.com/v1/projects/") + FB_PROJECT_ID +
               "/databases/(default)/documents/events";
  if (!http.begin(tls, url)) return;
  http.setTimeout(HTTP_TIMEOUT_MS);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("Authorization", String("Bearer ") + idToken);

  String body = String("{\"fields\":{") +
                "\"ts\":{\"integerValue\":\"" + String((unsigned long long)epochMs()) + "\"}," +
                "\"zone\":{\"stringValue\":\"" + ZONE_ID + "\"}," +
                "\"from\":{\"stringValue\":\"" + SEV[from] + "\"}," +
                "\"to\":{\"stringValue\":\"" + SEV[to] + "\"}," +
                "\"readings\":{\"stringValue\":\"" + readingSummary(r) + "\"}," +
                "\"acked\":{\"booleanValue\":false}}}";
  int code = http.POST(body);
  if (code != 200) Serial.printf("FUSE: event write -> %d\n", code);
  http.end();
  wdtFeed();
#endif
}

static void publish(const Reading &r) {
  String json = String("{\"ts\":{\".sv\":\"timestamp\"},") +
                "\"rssi\":" + String(WiFi.RSSI()) + "," +
                "\"ip\":\"" + WiFi.localIP().toString() + "\"," +
                "\"r/temp\":" + String(r.temp, 1) + "," +
                "\"r/gas\":" + String((int)r.gas) + "," +
                "\"r/smoke\":" + String(r.smoke, 1) + "," +
                "\"r/co\":" + String((int)r.co) +
                "}";
  rtdbPatch(String("/zones/") + ZONE_ID, json);
}

static void pollOverrides() {
  String body;
  if (rtdbGet(String("/zones/") + ZONE_ID + "/ov", body)) {
    if (body.startsWith("null") || body.length() == 0) {
      ovFan = -1;
      ovValve = "";
    } else {
      ovFan = (int)jsonNum(body, "fan", -1);
      ovValve = jsonStr(body, "valve");
    }
  }
  if (rtdbGet(String("/zones/") + ZONE_ID + "/silenced", body)) {
    bool want = body.startsWith("true");
    if (want && !silenced) {
      silenced = true;
      silencedAt = millis();
      silencedAtLevel = committedLevel;
    } else if (!want) {
      silenced = false;
    }
  }
  if (rtdbGet(String("/zones/") + ZONE_ID + "/r/flame", body)) {
    camFlame = body.startsWith("true");
    camFlameAt = millis();
  }
}

static Reading sample() {
  Reading r;

  dallas.requestTemperatures();
  float t = dallas.getTempCByIndex(0);
  if (t <= DEVICE_DISCONNECTED_C || isnan(t) || t > 125.0f) {
    tempFault = true;
    r.temp = lastGoodTemp;
  } else {
    tempFault = false;
    lastGoodTemp = t;
    r.temp = t;
  }

  uint32_t acc = 0;
  for (int i = 0; i < 16; i++) {
    acc += analogRead(MQ2_PIN);
    delayMicroseconds(200);
  }
  float raw = (acc / 16.0f) * MQ2_ADC_SCALE;
  if (raw > 4095.0f) raw = 4095.0f;

  bool warming = (millis() - bootAt) < MQ2_WARMUP_MS;
  r.gas = warming ? 0.0f : raw;

#if PUBLISH_SMOKE
  r.smoke = warming ? 0.0f : (raw * 20.0f / 4095.0f);
#else
  r.smoke = 0.0f;
#endif

  r.co = 0.0f;

  r.flame = camFlame && (millis() - camFlameAt) < CAM_FLAME_TTL_MS;

  return r;
}

static const int FAN_BY_LEVEL[4] = {0, 40, 70, 100};

static void driveBuzzer(int level) {
  if (silenced) {
    digitalWrite(BUZZER_PIN, LOW);
    return;
  }
  if (level <= 0) {
    digitalWrite(BUZZER_PIN, LOW);
    return;
  }
  if (level >= 3) {
    digitalWrite(BUZZER_PIN, HIGH);
    return;
  }
  uint32_t period = (level == 1) ? 2000 : 600;
  uint32_t on = (level == 1) ? 150 : 300;
  digitalWrite(BUZZER_PIN, (millis() % period) < on ? HIGH : LOW);
}

static void applyOutputs(int level) {
  int fanPct = (ovFan >= 0) ? ovFan : FAN_BY_LEVEL[level];
  if (fanPct > 100) fanPct = 100;
  FAN_PWM_WRITE((fanPct * 255) / 100);

  bool closed;
  if (ovValve == "CLOSED") closed = true;
  else if (ovValve == "OPEN") closed = false;
  else closed = (level >= 2);
  digitalWrite(VALVE_PIN, closed ? VALVE_CLOSE_LEVEL : !VALVE_CLOSE_LEVEL);

  driveBuzzer(level);
}

void setup() {
  Serial.begin(115200);
  delay(200);

  pinMode(VALVE_PIN, OUTPUT);
  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(VALVE_PIN, !VALVE_CLOSE_LEVEL);
  digitalWrite(BUZZER_PIN, LOW);
  FAN_PWM_BEGIN();
  FAN_PWM_WRITE(0);

  analogReadResolution(12);
  dallas.begin();

  bootAt = millis();
  wdtBegin();

  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.print("FUSE: wifi");
  uint32_t t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < 20000) {
    delay(400);
    Serial.print(".");
    wdtFeed();
  }
  Serial.println();

  tls.setInsecure();
  configTime(0, 0, "pool.ntp.org", "time.google.com");

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println(WiFi.localIP());
    ensureToken();
  }
  Serial.printf("FUSE: node up, zone=%s\n", ZONE_ID);
}

void loop() {
  wdtFeed();
  uint32_t now = millis();

  if (now - lastSample >= SAMPLE_MS) {
    lastSample = now;
    Reading r = sample();
    int raw = classify(r);

    if (raw != pendingLevel) {
      pendingLevel = raw;
      pendingSince = now;
    }
    if (pendingLevel != committedLevel) {
      uint32_t need = (pendingLevel > committedLevel) ? RISE_MS[pendingLevel] : FALL_MS;
      if (now - pendingSince >= need) {
        int from = committedLevel;
        committedLevel = pendingLevel;
        if (committedLevel > silencedAtLevel) silenced = false;
        Serial.printf("FUSE: %s -> %s (%s)\n", SEV[from], SEV[committedLevel],
                      readingSummary(r).c_str());
        fsAddEvent(from, committedLevel, r);
        publish(r);
        lastBeat = now;
      }
    }

    applyOutputs(committedLevel);

    if (now - lastBeat >= HEARTBEAT_MS) {
      lastBeat = now;
      if (WiFi.status() == WL_CONNECTED) {
        publish(r);
      }
      Serial.printf("FUSE: %s | temp %.1fC%s | gas %d | flame %s | fan %d%% | valve %s%s\n",
                    SEV[committedLevel], r.temp, tempFault ? " (PROBE FAULT)" : "",
                    (int)r.gas,
                    r.flame ? "CAM" : "none",
                    (ovFan >= 0 ? ovFan : FAN_BY_LEVEL[committedLevel]),
                    (committedLevel >= 2 || ovValve == "CLOSED") ? "CLOSED" : "OPEN",
                    silenced ? " | SILENCED" : "");
    }
  }

  if (silenced && millis() - silencedAt >= SILENCE_MS) {
    silenced = false;
  }

  if (now - lastPoll >= OVERRIDE_POLL_MS) {
    lastPoll = now;
    if (WiFi.status() == WL_CONNECTED) pollOverrides();
  }

  driveBuzzer(committedLevel);
}
