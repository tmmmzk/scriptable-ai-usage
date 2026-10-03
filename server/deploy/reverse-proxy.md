# 리버스 프록시 예시

서버는 `127.0.0.1:8787` 에서 평문 HTTP 로 동작하므로 TLS 는 프록시에서 처리합니다.
모든 `/v1/*` 요청은 서버가 API 키로 인증하고, `/healthz` 만 인증 없이 열려 있습니다.

## Caddy

```caddy
ai.example.com {
	reverse_proxy 127.0.0.1:8787
}
```

## nginx

```nginx
server {
    listen 443 ssl http2;
    server_name ai.example.com;

    # ssl_certificate ... ;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 90s;   # ?refresh=1 은 업스트림을 기다리므로 넉넉하게
    }
}
```

## Traefik (docker labels)

```yaml
labels:
  - traefik.enable=true
  - traefik.http.routers.aiusage.rule=Host(`ai.example.com`)
  - traefik.http.routers.aiusage.tls.certresolver=le
  - traefik.http.services.aiusage.loadbalancer.server.port=8787
```
