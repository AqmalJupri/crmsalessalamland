FROM node:22.23.1-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS base

FROM base AS dependencies
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
RUN --mount=type=secret,id=release_image_canary,required=true \
    test -s /run/secrets/release_image_canary
RUN corepack enable
COPY ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "./"]
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

FROM dependencies AS build-crm
ARG APP_VERSION
ENV APP_VERSION=$APP_VERSION \
    PRODUCT_SURFACE=crm
COPY . .
RUN pnpm build

FROM dependencies AS build-tasha
ARG APP_VERSION
ENV APP_VERSION=$APP_VERSION \
    PRODUCT_SURFACE=tasha
COPY . .
RUN pnpm build

FROM gcr.io/distroless/nodejs22-debian13:nonroot@sha256:a2723a2817c5b01b8e7b98d567bc8b5a6b0e713e25bfb0a82b6ade4b9db06f50 AS runtime-base
USER 0:0
WORKDIR /app
ENV HOME=/tmp \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1 \
    NODE_ENV=production \
    PORT=3000
EXPOSE 3000

FROM runtime-base AS release-crm
ARG OCI_SOURCE
ARG SOURCE_REVISION
ARG APP_VERSION
LABEL org.opencontainers.image.source=$OCI_SOURCE \
      org.opencontainers.image.revision=$SOURCE_REVISION \
      org.opencontainers.image.version=$APP_VERSION \
      com.salamland.product-surface=crm
ENV APP_VERSION=$APP_VERSION PRODUCT_SURFACE=crm
COPY --from=build-crm --chown=0:0 ["/app/.next/standalone", "./"]
COPY --from=build-crm --chown=0:0 ["/app/.next/static", "./.next/static"]
COPY --from=build-crm --chown=0:0 ["/app/public", "./public"]
USER 65532:65532
ENTRYPOINT []
CMD ["/nodejs/bin/node", "server.js"]

FROM runtime-base AS release-tasha
ARG OCI_SOURCE
ARG SOURCE_REVISION
ARG APP_VERSION
LABEL org.opencontainers.image.source=$OCI_SOURCE \
      org.opencontainers.image.revision=$SOURCE_REVISION \
      org.opencontainers.image.version=$APP_VERSION \
      com.salamland.product-surface=tasha
ENV APP_VERSION=$APP_VERSION PRODUCT_SURFACE=tasha
COPY --from=build-tasha --chown=0:0 ["/app/.next/standalone", "./"]
COPY --from=build-tasha --chown=0:0 ["/app/.next/static", "./.next/static"]
COPY --from=build-tasha --chown=0:0 ["/app/public", "./public"]
USER 65532:65532
ENTRYPOINT []
CMD ["/nodejs/bin/node", "server.js"]
