FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

ENV PORT=4173
EXPOSE 4173

CMD ["npm", "run", "start"]
