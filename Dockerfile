FROM node:22-alpine AS build

WORKDIR /app

COPY frontend/package*.json ./
RUN npm install

COPY frontend ./

# Vite inlines env vars at BUILD time, so it must be supplied as a build
# arg (docker-compose passes this from the root .env file) rather than a
# runtime environment variable on the nginx container.
ARG VITE_API_URL=http://localhost:8000
ENV VITE_API_URL=$VITE_API_URL

RUN npm run build

FROM nginx:alpine

COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
