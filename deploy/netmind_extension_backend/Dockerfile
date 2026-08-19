FROM python:3.12-slim


ENV https_proxy="http://10.208.187.1:3128/"
ENV http_proxy="http://10.208.187.1:3128/"

# EVERY host this service calls must be listed here LITERALLY. The CIDR entries
# below look like they cover the private ranges, and for curl they do — but
# httpx (and urllib, and requests) match NO_PROXY by hostname suffix only, so
# `10.0.0.0/8` becomes the pattern `*10.0.0.0/8` and matches nothing at all. An
# unlisted 10.x address is silently sent to the Squid proxy above, which answers
# 403 to destinations it does not serve. That is not a hypothetical: it is how
# both outbound calls this service makes came to fail.
#
#   10.254.139.24  SSO wrapper  — OIDC_USERINFO_ENDPOINT, every sign-in
#   10.221.141.71  LiteLLM      — LITELLM_BASE_URL, every key provisioned
#
# netmind.viettel.vn is listed for a different reason: nothing calls it today,
# but routing this host through a proxy that cannot reach it — and hairpinning
# back to the very nginx this container sits behind — is a trap worth leaving
# disarmed. Add a line here whenever a new outbound address appears in .env.
ENV no_proxy="127.0.0.1,localhost,forecaster,postgres,api,10.0.0.0/8,192.168.0.0/16,172.16.0.0/12,10.207.163.17,10.240.171.230,10.254.139.25,netmind.viettel.vn,10.254.139.24,10.221.141.71"
ENV NO_PROXY="127.0.0.1,localhost,forecaster,postgres,api,10.0.0.0/8,192.168.0.0/16,172.16.0.0/12,10.207.163.17,10.240.171.230,10.254.139.25,netmind.viettel.vn,10.254.139.24,10.221.141.71"

WORKDIR /app

# Dependencies first so a code change does not invalidate the pip layer.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

ARG APP_UID=1000
ARG APP_GID=1000
RUN mkdir -p /app/logs && chown -R ${APP_UID}:${APP_GID} /app
USER ${APP_UID}:${APP_GID}

EXPOSE 8000

# /health sits at the root path whatever API_BASE_PATH is set to, precisely so
# this check can reach uvicorn directly without nginx in the way.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=4).status == 200 else 1)"

# Two workers by default. Raise it and the rate limiter's effective ceiling
# rises with it (counters are per process), as does the connection count.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "2"]
