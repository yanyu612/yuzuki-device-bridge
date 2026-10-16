package com.wenxu.cachitobridge;

import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/** Loopback-only HTTP, with a per-install secret and an explicitly configured web origin. */
final class LocalBridgeServer {
    interface Handler {
        JSONObject status();
        String token();
        String allowedOrigin();
        boolean setPower(int power, long timeoutMs, boolean startNew);
        void stopDevice();
        void onServerError(String message);
    }
    static final int PORT = 8765;
    private final Handler handler;
    private volatile boolean running;
    private ServerSocket server;
    private ThreadPoolExecutor executor;

    LocalBridgeServer(Handler handler) { this.handler = handler; }

    synchronized void start() throws IOException {
        if (running) return;
        server = new ServerSocket();
        server.setReuseAddress(true);
        try { server.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), PORT), 16); }
        catch (IOException error) { server.close(); throw error; }
        executor = new ThreadPoolExecutor(2, 2, 0, TimeUnit.MILLISECONDS,
                new ArrayBlockingQueue<>(16), runnable -> {
                    Thread thread = new Thread(runnable, "device-bridge-client");
                    thread.setDaemon(true);
                    return thread;
                });
        running = true;
        Thread thread = new Thread(this::acceptLoop, "device-bridge-server");
        thread.setDaemon(true);
        thread.start();
    }

    synchronized void stop() {
        running = false;
        try { if (server != null) server.close(); } catch (IOException ignored) { }
        if (executor != null) executor.shutdownNow();
    }

    private void acceptLoop() {
        while (running) {
            try {
                Socket socket = server.accept();
                socket.setSoTimeout(2500);
                try { executor.execute(() -> handleClient(socket)); }
                catch (RuntimeException error) { socket.close(); }
            } catch (IOException error) {
                if (running) handler.onServerError("本机桥接连接异常");
            }
        }
    }

    private void handleClient(Socket socket) {
        try (socket) {
            try { handle(socket); }
            catch (BadRequest error) { write(socket, error.status, null, error(error.getMessage())); }
            catch (SocketTimeoutException ignored) { }
            catch (RuntimeException error) { write(socket, 400, null, error("请求格式无效")); }
            catch (org.json.JSONException error) { write(socket, 400, null, null); }
        } catch (IOException ignored) {
            // Disconnections are not Bluetooth faults. Never log headers, bodies or credentials.
        }
    }

    private void handle(Socket socket) throws IOException, BadRequest, org.json.JSONException {
        InputStream input = socket.getInputStream();
        String request = readLine(input, 2048);
        if (request == null) return;
        String[] parts = request.split(" ", -1);
        if (parts.length != 3 || !parts[2].equals("HTTP/1.1")) throw new BadRequest(400, "HTTP 请求无效");
        Map<String, String> headers = new HashMap<>();
        int headerBytes = 0;
        while (true) {
            String line = readLine(input, 4096);
            if (line == null) throw new BadRequest(400, "请求头不完整");
            if (line.isEmpty()) break;
            headerBytes += line.length();
            int colon = line.indexOf(':');
            if (colon < 1 || headers.size() >= 32 || headerBytes > 16384) throw new BadRequest(400, "请求头无效");
            String key = line.substring(0, colon).toLowerCase(Locale.ROOT);
            if (!key.matches("[a-z0-9-]+") || headers.put(key, line.substring(colon + 1).trim()) != null)
                throw new BadRequest(400, "重复或无效请求头");
        }
        String host = headers.get("host");
        if (!("127.0.0.1:8765".equals(host) || "localhost:8765".equals(host)))
            throw new BadRequest(403, "仅允许本机访问");
        if (headers.containsKey("transfer-encoding")) throw new BadRequest(400, "不支持分块请求");
        String origin = headers.get("origin");
        if (!BridgePolicy.allowsOrigin(handler.allowedOrigin(), origin))
            throw new BadRequest(403, "酒馆地址未授权，请在小助手里保存当前酒馆地址");
        String method = parts[0];
        String path = parts[1];
        if (method.equals("OPTIONS")) {
            if (!path.startsWith("/v1/")) throw new BadRequest(404, "接口不存在");
            write(socket, 204, origin, null);
            return;
        }
        if (!BridgePolicy.authenticated(handler.token(), headers.get("authorization"))) {
            write(socket, 401, origin, error("配对密钥不正确，请从小助手重新复制")); return;
        }
        if (method.equals("GET") && path.equals("/v1/status")) {
            write(socket, 200, origin, handler.status()); return;
        }
        if (!method.equals("POST")) { write(socket, 404, origin, error("接口不存在")); return; }
        if (path.equals("/v1/stop")) {
            handler.stopDevice();
            write(socket, 200, origin, new JSONObject().put("ok", true)); return;
        }
        if (!path.equals("/v1/suction")) { write(socket, 404, origin, error("接口不存在")); return; }
        if (!"application/json".equals(headers.getOrDefault("content-type", "").split(";", 2)[0].trim())) {
            write(socket, 415, origin, error("需要 JSON 请求")); return;
        }
        int length;
        try { length = Integer.parseInt(headers.getOrDefault("content-length", "-1")); }
        catch (NumberFormatException error) { throw new BadRequest(400, "内容长度无效"); }
        if (length < 1 || length > 4096) throw new BadRequest(413, "内容长度无效");
        byte[] body = new byte[length];
        int total = 0;
        while (total < length) {
            int count = input.read(body, total, length - total);
            if (count == -1) throw new BadRequest(400, "请求内容不完整");
            total += count;
        }
        JSONObject json;
        try { json = new JSONObject(new String(body, StandardCharsets.UTF_8)); }
        catch (Exception error) { write(socket, 400, origin, error("JSON 格式错误")); return; }
        Object rawPower = json.opt("power"), rawTimeout = json.opt("timeoutMs"), rawNew = json.opt("startNew");
        if (!(rawPower instanceof Integer) || !(rawTimeout instanceof Number) || !(rawNew instanceof Boolean)) {
            write(socket, 422, origin, error("缺少有效 power、timeoutMs 或 startNew")); return;
        }
        int power = (Integer) rawPower;
        Number timeout = (Number) rawTimeout;
        long timeoutMs = timeout.longValue();
        if (power < 0 || power > 100 || timeout.doubleValue() != (double) timeoutMs
                || (power >= 2 && !BridgePolicy.validTimeout(timeoutMs))) {
            write(socket, 422, origin, error("强度或截止时间无效")); return;
        }
        if (!BridgeConfig.PROFILE_ID.equals(json.optString("profileId"))) {
            write(socket, 422, origin, error("此桥接版本尚不支持该型号")); return;
        }
        if (!handler.setPower(power, timeoutMs, (Boolean) rawNew)) {
            write(socket, 409, origin, error("蓝牙不可用、桥接关闭或指令已过期，请检查小助手")); return;
        }
        write(socket, 200, origin, new JSONObject().put("ok", true).put("accepted", true));
    }

    private static String readLine(InputStream input, int limit) throws IOException, BadRequest {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        while (true) {
            int value = input.read();
            if (value == -1) return bytes.size() == 0 ? null : bytes.toString(StandardCharsets.US_ASCII.name());
            if (value == '\n') {
                byte[] line = bytes.toByteArray();
                if (line.length == 0 || line[line.length - 1] != '\r') throw new BadRequest(400, "需要 CRLF 请求头");
                return new String(line, 0, line.length - 1, StandardCharsets.US_ASCII);
            }
            if (bytes.size() >= limit || value > 127 || value == 0) throw new BadRequest(400, "请求行过长或无效");
            bytes.write(value);
        }
    }

    private static JSONObject error(String text) {
        try { return new JSONObject().put("ok", false).put("error", text); }
        catch (org.json.JSONException impossible) { throw new IllegalStateException(impossible); }
    }

    private static void write(Socket socket, int status, String origin, JSONObject body) throws IOException {
        byte[] bytes = body == null ? new byte[0] : body.toString().getBytes(StandardCharsets.UTF_8);
        StringBuilder header = new StringBuilder("HTTP/1.1 " + status + " " + reason(status) + "\r\n")
                .append("Content-Type: application/json; charset=utf-8\r\nContent-Length: ").append(bytes.length)
                .append("\r\nCache-Control: no-store\r\nConnection: close\r\n");
        if (origin != null) header.append("Access-Control-Allow-Origin: ").append(origin)
                .append("\r\nVary: Origin\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS")
                .append("\r\nAccess-Control-Allow-Headers: Content-Type, Authorization")
                .append("\r\nAccess-Control-Allow-Private-Network: true\r\n");
        socket.getOutputStream().write(header.append("\r\n").toString().getBytes(StandardCharsets.US_ASCII));
        socket.getOutputStream().write(bytes);
        socket.getOutputStream().flush();
    }

    private static String reason(int status) {
        return switch (status) {
            case 200 -> "OK"; case 204 -> "No Content"; case 400 -> "Bad Request";
            case 401 -> "Unauthorized"; case 403 -> "Forbidden"; case 404 -> "Not Found";
            case 409 -> "Conflict"; case 413 -> "Content Too Large"; case 415 -> "Unsupported Media Type";
            case 422 -> "Unprocessable Content"; default -> "Error";
        };
    }
    private static final class BadRequest extends Exception {
        final int status;
        BadRequest(int status, String text) { super(text); this.status = status; }
    }
}
