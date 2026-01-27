pipeline {
    agent any
    
    stages {
        stage('Checkout') {
            steps {
                git branch: 'main', url: 'https://github.com/narang24/Ping-Pilott-Backend.git'
            }
        }
        
        stage('Install Dependencies') {
            steps {
                sh 'npm install'
            }
        }
        
        stage('Build Docker Image') {
            steps {
                sh 'docker build -t ping-pilot:${BUILD_NUMBER} .'
            }
        }
        
        stage('Deploy') {
            steps {
                sh 'docker run -d -p 3000:3000 --name ping-pilot-${BUILD_NUMBER} ping-pilot:${BUILD_NUMBER}'
            }
        }
    }
}