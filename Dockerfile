FROM node:7-alpine

RUN apk add --update git && \
rm -rf /tmp/* /var/cache/apk/*

RUN mkdir -p /app/runtime
RUN mkdir -p /app/repositories
WORKDIR /app

ENV PATH=/app/node_modules/.bin:$PATH
ENV NODE_ENV=production

COPY package.json /app/
COPY runtime/package.json /app/runtime/
RUN npm install --only=production --ignore-scripts

COPY . /app/

EXPOSE 8002

VOLUME ["/app/repositories"]

CMD ["npm", "start"]
