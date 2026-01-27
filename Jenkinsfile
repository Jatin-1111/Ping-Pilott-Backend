pipeline {
    agent any
    
    stages {
        stage('Checkout') {
            steps {
                git branch: 'main', url: 'https://github.com/narang24/Ping-Pilott-Backend.git', credentialsId: 'github-credentials'
            }
        }
        
        stage('Install Dependencies') {
            steps {
                bat 'npm install'
            }
        }
        
        stage('Build Docker Image') {
            steps {
                bat 'docker build -t ping-pilot:%BUILD_NUMBER% .'
            }
        }
        
        stage('Deploy') {
            steps {
                bat 'docker run -d -p 3000:3000 --name ping-pilot-%BUILD_NUMBER% ping-pilot:%BUILD_NUMBER%'
            }
        }
    }

    post {
        success {
            githubNotify context: 'jenkins/build', status: 'SUCCESS', description: 'Build passed', targetUrl: env.BUILD_URL, credentialsId: 'github-credentials'
        }
        failure {
            githubNotify context: 'jenkins/build', status: 'FAILURE', description: 'Build failed', targetUrl: env.BUILD_URL, credentialsId: 'github-credentials'
        }
    }
}