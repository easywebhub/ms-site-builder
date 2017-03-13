FROM node:7-alpine

RUN apk add --update git && \
rm -rf /tmp/* /var/cache/apk/*

RUN mkdir -p /app
WORKDIR /app

ENV PATH=/app/node_modules/.bin:$PATH
ENV NODE_ENV=production

COPY package.json /app/
RUN npm install --only=production --ignore-scripts

COPY . /app/

EXPOSE 9004

CMD ["npm", "start"]
