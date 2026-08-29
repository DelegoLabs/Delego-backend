FROM node:22-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy source
COPY tsconfig.json ./
COPY src ./src

# Build
RUN npm run build

# Create models directory
RUN mkdir -p /app/models

# Expose port
EXPOSE 3013

# Start the service
CMD ["node", "dist/index.js"]
