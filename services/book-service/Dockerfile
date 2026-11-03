FROM node:18-alpine

# Set working directory inside container
WORKDIR /app

# Copy package files first (layer caching)
COPY package*.json ./
RUN npm install --production

# Copy source code
COPY src/ ./src/

# Expose the service port
EXPOSE 3002

# Start the service
CMD ["node", "src/server.js"]
